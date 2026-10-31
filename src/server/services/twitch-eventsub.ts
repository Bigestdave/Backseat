import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import type { AppConfig } from "../config";
import type { Database } from "../db/client";
import type { ChatMessage } from "./chat-routing";
import { TwitchTokenService } from "./twitch";

type EventSubEnvelope = {
  metadata: {
    message_id: string;
    message_type: "session_welcome" | "session_keepalive" | "session_reconnect" | "notification" | "revocation";
  };
  payload: {
    session?: { id: string; reconnect_url?: string | null; keepalive_timeout_seconds?: number | null };
    subscription?: {
      type?: string;
      status?: string;
      condition?: { broadcaster_user_id?: string };
    };
    event?: {
      broadcaster_user_id: string;
      source_broadcaster_user_id?: string | null;
      chatter_user_id: string;
      message_id: string;
      message?: { text?: string };
    };
  };
};

export class TwitchEventSubService {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private keepaliveTimeoutSeconds: number | null = null;
  private readonly subscriptions = new Map<string, { id: string; twitchId: string }>();
  private readonly primarySockets = new WeakSet<WebSocket>();

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly tokens: TwitchTokenService,
    private readonly onChatMessage: (message: ChatMessage) => Promise<void>,
    private readonly onChatConnection: (userId: string, connected: boolean) => Promise<void>,
    private readonly logger: FastifyBaseLogger
  ) {}

  start(): void {
    void this.reconcile().catch((error: unknown) => {
      this.logger.warn({ err: error }, "Twitch EventSub startup reconciliation failed");
    });
  }

  async reconcile(): Promise<void> {
    const users = await this.database.client<{ userId: string }[]>`
      SELECT DISTINCT g.user_id AS "userId"
      FROM oauth_grants g
      JOIN active_battle_members active_member ON active_member.user_id = g.user_id
      JOIN battles battle ON battle.id = active_member.battle_id
      WHERE g.revoked_at IS NULL
        AND battle.status <> 'ended'
        AND g.scopes ? 'user:read:chat'
    `;
    const activeUserIds = new Set(users.map(({ userId }) => userId));
    for (const [userId, subscription] of this.subscriptions) {
      if (activeUserIds.has(userId)) continue;
      try {
        await this.unsubscribeCreator(userId, subscription.id);
        this.subscriptions.delete(userId);
        await this.onChatConnection(userId, false);
      } catch (error) {
        this.logger.warn({ err: error, userId }, "Twitch chat subscription could not be removed");
      }
    }

    // EventSub closes a WebSocket that receives no subscription within its
    // welcome window. Do not keep an idle socket alive before a creator opens
    // a battle; establish it only once there is work to subscribe to.
    if (users.length === 0) {
      if (this.socket) await this.stop();
      return;
    }

    if (!this.socket) {
      this.connect("wss://eventsub.wss.twitch.tv/ws", false);
      return;
    }
    if (!this.sessionId) return;

    for (const { userId } of users) {
      if (this.subscriptions.has(userId)) continue;
      try {
        const subscription = await this.subscribeCreator(userId);
        this.subscriptions.set(userId, subscription);
        await this.onChatConnection(userId, true);
      } catch (error) {
        this.logger.warn({ err: error, userId }, "Twitch chat subscription was not created");
      }
    }
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.socket?.close();
    this.socket = null;
    this.sessionId = null;
    this.keepaliveTimeoutSeconds = null;
    this.subscriptions.clear();
  }

  private connect(url: string, plannedReconnect: boolean): void {
    const socket = new WebSocket(url);
    if (!plannedReconnect) this.primarySockets.add(socket);
    socket.on("message", (data) => {
      void this.receive(socket, data.toString(), plannedReconnect).catch((error: unknown) => {
        this.logger.error({ err: error }, "Twitch EventSub message could not be processed");
      });
    });
    socket.on("error", (error) => this.logger.warn({ err: error }, "Twitch EventSub socket error"));
    socket.on("close", () => {
      if (this.socket !== socket || !this.primarySockets.has(socket)) return;
      this.socket = null;
      this.sessionId = null;
      this.keepaliveTimeoutSeconds = null;
      const disconnectedUsers = [...this.subscriptions.keys()];
      this.subscriptions.clear();
      for (const userId of disconnectedUsers) {
        void this.onChatConnection(userId, false).catch((error: unknown) => {
          this.logger.warn({ err: error, userId }, "Twitch chat disconnect could not be recorded");
        });
      }
      if (this.livenessTimer) clearTimeout(this.livenessTimer);
      this.scheduleReconnect();
    });
    if (!plannedReconnect) this.socket = socket;
  }

  private async receive(socket: WebSocket, payload: string, plannedReconnect: boolean): Promise<void> {
    let message: EventSubEnvelope;
    try {
      message = JSON.parse(payload) as EventSubEnvelope;
    } catch {
      this.logger.warn("Discarded malformed Twitch EventSub message");
      return;
    }
    this.touchLiveness(socket);

    if (message.metadata.message_type === "session_welcome" && message.payload.session?.id) {
      const oldSocket = plannedReconnect ? this.socket : null;
      this.socket = socket;
      this.primarySockets.add(socket);
      this.sessionId = message.payload.session.id;
      this.keepaliveTimeoutSeconds = message.payload.session.keepalive_timeout_seconds ?? 10;
      this.touchLiveness(socket);
      if (plannedReconnect) {
        oldSocket?.close();
      } else {
        await this.reconcile();
      }
      return;
    }

    if (message.metadata.message_type === "session_reconnect" && message.payload.session?.reconnect_url) {
      this.connect(message.payload.session.reconnect_url, true);
      return;
    }

    if (message.metadata.message_type === "notification" && message.payload.subscription?.type === "channel.chat.message") {
      const event = message.payload.event;
      if (!event?.message_id || !event.message?.text) return;
      // Shared Chat is explicitly outside this MVP. A forwarded message can
      // appear in a participating channel but originate in another channel;
      // ignore it rather than counting it for the wrong community.
      if (event.source_broadcaster_user_id && event.source_broadcaster_user_id !== event.broadcaster_user_id) {
        return;
      }
      await this.onChatMessage({
        deliveryId: message.metadata.message_id,
        messageId: event.message_id,
        sourceChannelTwitchId: event.broadcaster_user_id,
        viewerTwitchId: event.chatter_user_id,
        text: event.message.text,
        receivedAt: new Date()
      });
      return;
    }

    if (message.metadata.message_type === "revocation") {
      this.logger.warn({ status: message.payload.subscription?.status }, "Twitch EventSub subscription was revoked");
      const broadcasterId = message.payload.subscription?.condition?.broadcaster_user_id;
      if (broadcasterId) {
        for (const [userId, subscription] of this.subscriptions) {
          if (subscription.twitchId !== broadcasterId) continue;
          this.subscriptions.delete(userId);
          await this.onChatConnection(userId, false);
          break;
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect("wss://eventsub.wss.twitch.tv/ws", false);
    }, 3000);
  }

  private touchLiveness(socket: WebSocket): void {
    if (this.socket !== socket || !this.keepaliveTimeoutSeconds) return;
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    // Twitch's welcome includes a server-selected timeout. Ten seconds is the
    // protocol default used when a welcome omits it in a malformed test frame.
    this.livenessTimer = setTimeout(() => socket.terminate(), (this.keepaliveTimeoutSeconds + 1) * 1000);
  }

  private async subscribeCreator(userId: string): Promise<{ id: string; twitchId: string }> {
    if (!this.sessionId) throw new Error("Twitch EventSub has no active session.");
    const { accessToken, twitchId } = await this.tokens.accessTokenForUser(userId);
    const response = await fetch("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": this.config.TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: twitchId, user_id: twitchId },
        transport: { method: "websocket", session_id: this.sessionId }
      })
    });
    if (!response.ok) throw new Error(`Twitch rejected chat subscription (${response.status}).`);
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    const id = payload.data?.[0]?.id;
    if (!id) throw new Error("Twitch accepted a chat subscription without returning its id.");
    return { id, twitchId };
  }

  private async unsubscribeCreator(userId: string, subscriptionId: string): Promise<void> {
    const { accessToken } = await this.tokens.accessTokenForUser(userId);
    const response = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions?id=${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": this.config.TWITCH_CLIENT_ID
      }
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Twitch rejected chat unsubscription (${response.status}).`);
    }
  }
}

