import { schema } from '@orch/domain'
import type { ServerMachine } from '@orch/shared'
import { eq } from 'drizzle-orm'
import type { UserData } from '../../lib/createServerRouter'
import type { MachineRegistry } from '../tunnel/tunnel.service'

/** One user's machines, through the scoped repository. */
type Machines = UserData['machines']

type MachineRow = typeof schema.machines.$inferSelect

/**
 * The signed-in user's machines, as the accounts API sees them. Every query
 * goes through the user's scoped repository, and online state comes from the
 * in-memory `registry`, so it is only right with one server instance.
 */
export class MachinesService {
  constructor(
    private readonly machines: Machines,
    private readonly registry: MachineRegistry,
  ) {}

  /** The user's machines, newest `lastOpenedAt` first. */
  async list(): Promise<ServerMachine[]> {
    const rows = await this.machines.list()
    rows.sort((a, b) => b.lastOpenedAt.getTime() - a.lastOpenedAt.getTime())
    return rows.map((row) => this.toMachine(row))
  }

  /**
   * Links `machineId` to the user. Linking it again keeps the name the user
   * chose and only refreshes `lastOpenedAt`, so opening a connect link twice
   * never undoes a rename.
   */
  async link(machineId: string, name: string): Promise<ServerMachine> {
    const now = new Date()
    const existing = await this.refresh(machineId, now)
    if (existing) return existing
    try {
      return this.toMachine(await this.machines.insert({ machineId, name, lastOpenedAt: now, createdAt: now }))
    } catch (error) {
      // Another request linked the same machine between the lookup and the insert, and the unique index refused
      // this one. That request's row is the answer.
      const raced = await this.refresh(machineId, now)
      if (raced) return raced
      throw error
    }
  }

  /** Renames the user's machine. Null means the user hasn't linked it. */
  async rename(machineId: string, name: string): Promise<ServerMachine | null> {
    const [row] = await this.machines.update(eq(schema.machines.machineId, machineId), { name })
    return row ? this.toMachine(row) : null
  }

  /** Removes the machine from the user's account. False means the user hasn't linked it. */
  async unlink(machineId: string): Promise<boolean> {
    return (await this.machines.delete(eq(schema.machines.machineId, machineId))).length > 0
  }

  private async refresh(machineId: string, now: Date): Promise<ServerMachine | null> {
    const [row] = await this.machines.update(eq(schema.machines.machineId, machineId), { lastOpenedAt: now })
    return row ? this.toMachine(row) : null
  }

  private toMachine(row: MachineRow): ServerMachine {
    return {
      machineId: row.machineId,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      lastOpenedAt: row.lastOpenedAt.toISOString(),
      online: this.registry.get(row.machineId) !== undefined,
    }
  }
}
