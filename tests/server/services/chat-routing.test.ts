import { describe, expect, it } from "vitest";
import {
  parseVoteCommand,
  routeVote,
  type BattleRoutingContext,
  type ChatMessage
} from "../../../src/server/services/chat-routing";

const battle: BattleRoutingContext = {
  battleId: "battle-123",
  host: {
    userId: "user-host",
    twitchId: "twitch-host-42",
    displayName: "A creator named Guest"
  },
  guest: {
    userId: "user-guest",
    twitchId: "twitch-guest-99",
    displayName: "A creator named Host"
  }
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    deliveryId: "delivery-1",
    messageId: "message-1",
    sourceChannelTwitchId: battle.host.twitchId,
    viewerTwitchId: "viewer-7",
    text: "!vote 1",
    receivedAt: new Date("2026-10-29T00:00:00.000Z"),
    ...overrides
  };
}

describe("parseVoteCommand", () => {
  it.each([
    ["!vote 1", 1],
    ["!VOTE 2", 2],
    ["  !vote\t3  ", 3]
  ] as const)("parses %s", (text, expected) => {
    expect(parseVoteCommand(text)).toBe(expected);
  });

  it.each([
    "",
    "!vote",
    "!vote1",
    "!vote 0",
    "!vote 4",
    "!vote 1 please",
    "hello !vote 1",
    "!pick 1"
  ])("rejects non-vote command %j", (text) => {
    expect(parseVoteCommand(text)).toBeNull();
  });
});

describe("routeVote", () => {
  it("routes a host-channel vote to the guest using stable Twitch IDs", () => {
    const vote = routeVote(message({ text: "!vote 2" }), battle);

    expect(vote).toEqual({
      battleId: battle.battleId,
      targetUserId: battle.guest.userId,
      targetDisplayName: battle.guest.displayName,
      option: 2
    });
  });

  it("routes a guest-channel vote to the host", () => {
    const vote = routeVote(message({
      sourceChannelTwitchId: battle.guest.twitchId,
      text: "!vote 3"
    }), battle);

    expect(vote).toEqual({
      battleId: battle.battleId,
      targetUserId: battle.host.userId,
      targetDisplayName: battle.host.displayName,
      option: 3
    });
  });

  it.each([
    ["host", battle.host.twitchId],
    ["guest", battle.guest.twitchId]
  ])("excludes the participating %s creator from voting", (_creator, viewerTwitchId) => {
    expect(routeVote(message({ viewerTwitchId }), battle)).toBeNull();
  });

  it("ignores votes from a channel outside the two creators' battle", () => {
    expect(routeVote(message({ sourceChannelTwitchId: "unrelated-channel" }), battle)).toBeNull();
  });

  it("does not route malformed commands", () => {
    expect(routeVote(message({ text: "!vote 9" }), battle)).toBeNull();
  });
});
