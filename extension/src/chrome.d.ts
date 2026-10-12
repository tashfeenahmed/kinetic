/**
 * The slice of the chrome.* extension API Kinetic Companion uses.
 * (@types/chrome isn't a dependency; this keeps the lockfile unchanged.)
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender { tab?: chrome.tabs.Tab; id?: string; url?: string }
    const id: string;
    const lastError: { message?: string } | undefined;
    function getURL(path: string): string;
    function getManifest(): { version: string; name: string };
    function sendMessage<T = any>(message: unknown): Promise<T>;
    function openOptionsPage(): Promise<void>;
    const onMessage: {
      addListener(cb: (message: any, sender: MessageSender, sendResponse: (response?: any) => void) => boolean | void): void;
    };
    const onInstalled: { addListener(cb: (details: { reason: string }) => void): void };
    const onStartup: { addListener(cb: () => void): void };
  }

  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | null): Promise<Record<string, any>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: StorageArea;
    const session: StorageArea;
    const onChanged: { addListener(cb: (changes: Record<string, { oldValue?: any; newValue?: any }>, area: string) => void): void };
  }

  namespace alarms {
    interface Alarm { name: string; scheduledTime: number }
    function create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
    function clear(name: string): Promise<boolean>;
    const onAlarm: { addListener(cb: (alarm: Alarm) => void): void };
  }

  namespace tabs {
    interface Tab { id?: number; url?: string; status?: string; active: boolean; windowId: number; pendingUrl?: string }
    function get(tabId: number): Promise<Tab>;
    function query(q: { url?: string | string[]; active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function create(p: { url: string; active?: boolean; pinned?: boolean }): Promise<Tab>;
    function update(tabId: number, p: { url?: string; active?: boolean }): Promise<Tab>;
    function sendMessage<T = any>(tabId: number, message: unknown): Promise<T>;
    const onUpdated: {
      addListener(cb: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void;
      removeListener(cb: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void;
    };
    const onRemoved: { addListener(cb: (tabId: number) => void): void };
  }

  namespace scripting {
    function executeScript(d: { target: { tabId: number }; files: string[]; world?: 'ISOLATED' | 'MAIN' }): Promise<unknown[]>;
  }

  namespace notifications {
    function create(id: string, o: { type: 'basic'; iconUrl: string; title: string; message: string; priority?: number }): Promise<string>;
  }

  namespace action {
    function setBadgeText(d: { text: string }): Promise<void>;
    function setBadgeBackgroundColor(d: { color: string }): Promise<void>;
    function setTitle(d: { title: string }): Promise<void>;
  }

  namespace permissions {
    function request(p: { origins?: string[] }): Promise<boolean>;
    function contains(p: { origins?: string[] }): Promise<boolean>;
  }
}
