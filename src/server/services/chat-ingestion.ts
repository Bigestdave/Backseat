import type { ChatMessage } from "./chat-routing";
import { BattleService, type ChatVoteResult } from "./battle-service";

export type IngestionResult = ChatVoteResult;

export class ChatIngestionService {
  constructor(private readonly battles: BattleService) {}

  async ingest(message: ChatMessage): Promise<IngestionResult> {
    // The service rejects non-votes before persistence and handles the
    // durable delivery, message, team-lock, and replacement-vote invariants.
    return this.battles.ingestChatVote(message);
  }
}

