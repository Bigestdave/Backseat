import { EventEmitter } from "node:events";

export class BattleEventBus {
  private readonly emitter = new EventEmitter();

  publish(battleId: string): void {
    this.emitter.emit(battleId);
  }

  subscribe(battleId: string, listener: () => void): () => void {
    this.emitter.on(battleId, listener);
    return () => this.emitter.off(battleId, listener);
  }
}

