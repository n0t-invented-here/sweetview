// What a tab's page and the UI thread say to each other. Every method is
// answered on the UI thread (`uiMethods`); this demo has no worker.

/** What a page shows about its own tab. */
export type TabInfo = {
  /** Counts up from 1 as tabs are opened; never reused, so it names the tab for its whole life. */
  number: number;
  title: string;
  /** How many tabs are open right now. */
  tabs: number;
};

export type Methods = {
  /** The page is up and asks who it is. A new tab joins the tab bar when its page first asks. */
  "tab.info": [void, TabInfo];
  /** Open a tab after this one: a web address ("bun.sh", "https://…"), or null for another page like this. Rejects an address that is not http or https. */
  "tab.open": [string | null, void];
  /** Retitle this tab; an empty title restores "Tab n". */
  "tab.rename": [string, void];
  "tab.close": [void, void];
};

export type Events = {
  /** A tab opened or closed. */
  tabs: { count: number };
};
