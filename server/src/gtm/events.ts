import { EventEmitter } from 'node:events';

/** Per-table change feed, streamed to the browser over SSE. */
export type TableEvent =
  | { type: 'cell'; tableId: number; rowId: number; columnId: number; cell: unknown }
  | { type: 'rows'; tableId: number }
  | { type: 'columns'; tableId: number }
  | { type: 'queue'; tableId: number; pending: number; running: number };

export class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }
  publish(e: TableEvent) {
    this.emit(`table:${e.tableId}`, e);
  }
}
