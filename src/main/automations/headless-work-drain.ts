export class HeadlessAutomationWorkDrain {
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly enabled: boolean) {}

  track<T>(work: Promise<T>): Promise<T> {
    if (!this.enabled) {
      return work
    }
    let settlement: Promise<void>
    settlement = work.then(
      () => {
        this.pending.delete(settlement)
      },
      () => {
        this.pending.delete(settlement)
      }
    )
    this.pending.add(settlement)
    return work
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(this.pending)
    }
  }
}
