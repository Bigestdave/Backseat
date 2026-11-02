export type ChatMessage = {
  deliveryId: string;
  messageId: string;
  sourceChannelTwitchId: string;
  viewerTwitchId: string;
  text: string;
  receivedAt: Date;
};

export type BattleRoutingContext = {
  battleId: string;
  host: { userId: string; twitchId: string; displayName: string };
  guest: { userId: string; twitchId: string; displayName: string };
};

export type RoutedVote = {
  battleId: string;
  targetUserId: string;
  targetDisplayName: string;
  option: 1 | 2 | 3 | 4;
};

export function parseVoteCommand(text: string): 1 | 2 | 3 | 4 | null {
  // !pick is the visible Backseat command. !vote remains a quiet alias so a
  // previously shared command does not suddenly stop working mid-session.
  const match = /^!(?:pick|vote)\s+([1-4])\s*$/i.exec(text.trim());
  return match ? (Number(match[1]) as 1 | 2 | 3 | 4) : null;
}

export function routeVote(message: ChatMessage, battle: BattleRoutingContext): RoutedVote | null {
  const option = parseVoteCommand(message.text);
  if (!option) return null;
  if (message.viewerTwitchId === battle.host.twitchId || message.viewerTwitchId === battle.guest.twitchId) {
    return null;
  }

  if (message.sourceChannelTwitchId === battle.host.twitchId) {
    return {
      battleId: battle.battleId,
      targetUserId: battle.guest.userId,
      targetDisplayName: battle.guest.displayName,
      option
    };
  }

  if (message.sourceChannelTwitchId === battle.guest.twitchId) {
    return {
      battleId: battle.battleId,
      targetUserId: battle.host.userId,
      targetDisplayName: battle.host.displayName,
      option
    };
  }

  return null;
}

