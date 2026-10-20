// discipline-whale, browser half: the whale's own entry in the Web sidebar.
//
// The entry sits in the sidebar's panel list, directly above Context Insights.
// Selecting it opens the whale's main session in the normal conversation view.
// The main session runs in the whale's home ($DSH_HOME/discipline-whale/home),
// a private working directory that is never registered as a workspace. The
// host row records the main session and serves it on
// /api/discipline-whale/home; when the recorded session is gone, a POST there
// makes the host create, wake and record a new one.
//
// Plain JS in dsh's module wrapper, so the package needs no build step: React
// comes from the shell's module table.
window.__ModuleLoader__.load({
  id: "discipline-whale",
  factory: (require) => {
    var module = { exports: {} };
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "discipline-whale";
    const NS = "discipline-whale";
    const HOME_ROUTE = "/api/discipline-whale/home";
    // Built-in panels: Plugins 0, Automations 10, Context Insights 20.
    const PANEL_ORDER = 15;

    const DICTIONARIES = {
      zh: {
        panel: "自律鲸鱼",
        opening: "正在打开自律鲸鱼主会话…",
        failed: "打开主会话失败：{reason}",
        retry: "重试",
      },
      en: {
        panel: "Discipline Whale",
        opening: "Opening the Discipline Whale main session…",
        failed: "Could not open the main session: {reason}",
        retry: "Retry",
      },
    };

    // ---- the home and its main session ------------------------------------

    async function homeRoute(method) {
      const response = await fetch(HOME_ROUTE, { method, cache: "no-store" });
      if (!response.ok) throw new Error(`${HOME_ROUTE} answered HTTP ${response.status}`);
      return response.json();
    }

    // isLive says whether a recorded main session can still be opened: it must
    // not be archived, and once the session list has loaded it must be listed.
    function isLive(sessionId, sessionSnapshot, workspaceSnapshot) {
      if (typeof sessionId !== "string" || sessionId === "") return false;
      const archived = Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [];
      if (archived.includes(sessionId)) return false;
      const ids = Array.isArray(sessionSnapshot?.ids) ? sessionSnapshot.ids : [];
      return ids.length === 0 || sessionSnapshot.byId?.[sessionId] !== undefined;
    }

    // One open at a time: a remount or a second click joins the running one.
    let opening = null;
    function openMainSession(ctx) {
      if (opening === null) {
        opening = openOrCreate(ctx).finally(() => {
          opening = null;
        });
      }
      return opening;
    }

    async function openOrCreate(ctx) {
      let { mainSessionId } = await homeRoute("GET");
      if (!isLive(mainSessionId, ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot())) {
        ({ mainSessionId } = await homeRoute("POST"));
        if (typeof mainSessionId !== "string") throw new Error("the host recorded no main session");
      }
      ctx.uiWorkspace.openSession(mainSessionId);
    }

    // ---- views ------------------------------------------------------------

    function WhaleIcon(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("path", { d: "M3 11.5c0-2.5 2-4.5 4.5-4.5h6c2 0 3.5 1 4.5 2.5L20 7.5v6l-2-2c-1 1.5-2.5 2.5-4.5 2.5h-6C5 14 3 12 3 11.5z" }),
        h("circle", { cx: 7, cy: 10, r: 0.6, fill: "currentColor" }),
        h("path", { d: "M3 18c1.2-1 2.3-1 3.5 0s2.3 1 3.5 0 2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0" })
      );
    }

    function makeWhalePage(ctx, t) {
      return function WhalePage() {
        const [error, setError] = React.useState(null);
        const [attempt, setAttempt] = React.useState(0);

        React.useEffect(() => {
          let alive = true;
          openMainSession(ctx).catch((reason) => {
            if (alive) setError(String(reason?.message ?? reason));
          });
          return () => {
            alive = false;
          };
        }, [attempt]);

        const body = error === null
          ? h("p", null, t("opening"))
          : [
              h("p", { key: "msg" }, t("failed", { reason: error })),
              h("button", { key: "retry", type: "button", className: "dw-retry", onClick: () => { setError(null); setAttempt((n) => n + 1); } }, t("retry")),
            ];
        return h("section", { className: "dw-page", "aria-label": t("panel") }, body);
      };
    }

    function installStyles() {
      const style = document.createElement("style");
      style.dataset.dshPlugin = "discipline-whale";
      style.textContent =
        ".dw-page{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-text-secondary,inherit)}" +
        ".dw-retry{padding:4px 12px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}";
      document.head.appendChild(style);
      return () => style.remove();
    }

    // ---- activation -------------------------------------------------------

    function apply(ctx) {
      ctx.effect(installStyles, "discipline-whale: styles");
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), "discipline-whale: dictionaries");
      const t = ctx.locale.bind(NS);
      const WhalePage = makeWhalePage(ctx, t);
      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID }, WhalePage)
      );
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: PANEL_ORDER, label: () => t("panel") }, WhaleIcon)
      );
    }

    module.exports.inject = ["slots", "locale", "layout", "uiWorkspace", "workspaces", "sessions"];
    module.exports.apply = apply;
    // For the tests; the host reads only inject and apply.
    module.exports.isLive = isLive;
    return module.exports;
  },
});
