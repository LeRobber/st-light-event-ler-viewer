jQuery(async () => {

    // ---------------------------------
    // ST READY
    // ---------------------------------

    async function waitForST() {
        return new Promise(resolve => {
            const check = () => {
                if (window.SillyTavern && SillyTavern.getContext) {
                    resolve();
                } else {
                    setTimeout(check, 250);
                }
            };
            check();
        });
    }

    await waitForST();

    const context = SillyTavern.getContext();

    const {
        eventSource,
        event_types,
        SlashCommandParser,
        SlashCommand
    } = context;

    console.log("[EventDebugger] Ready");

    // ---------------------------------
    // STATE
    // ---------------------------------

    let popupWindow = null;
    let logContainer = null;

    let hiddenPayloadEvents = new Set();

    // STREAM STATE
    let streamFirstTokenSeen = false;
    let streamHasLoggedMid = false;
    let lastStreamTokenData = null;

    // SWIPE STATE
    let messageSwipeState = new Map();
    let activeSwipeMessageId = null;

    function getMessageId(el) {
        return el?.getAttribute?.("mesid")
            || el?.dataset?.mesid
            || el?.id
            || null;
    }

    // ---------------------------------
    // REDACTION
    // ---------------------------------

    function redactStream(text) {

        if (!text || typeof text !== "string") return text;
        if (text.length <= 6) return text;

        const first3 = text.slice(0, 3);
        const last3 = text.slice(-3);
        const hiddenCount = text.length - 6;

        return `${first3}...REDACTED ${hiddenCount} CHAR...${last3}`;
    }

    // ---------------------------------
    // LOGGING
    // ---------------------------------

    function logEvent(name, data) {

        if (!popupWindow || popupWindow.closed || !logContainer) return;

        const el = popupWindow.document.createElement("div");
        el.className = "event";

        const time = new Date().toLocaleTimeString();

        let payload;

        // NOTE: kept simple; you can extend this per-event filtering later
        if (hiddenPayloadEvents.size > 0 && hiddenPayloadEvents.has(name)) {
            payload = "[payload hidden]";
        } else {
            try {
                payload = JSON.stringify(data, null, 2);
            } catch {
                payload = String(data);
            }
        }

        el.innerHTML = `
            <div class="name">${name}</div>
            <div class="time">${time}</div>
            <details class="payload">
                <summary>payload</summary>
                <pre></pre>
            </details>
        `;

        el.querySelector("pre").textContent = payload;

        logContainer.prepend(el);

        while (logContainer.children.length > 100000) {
            logContainer.lastChild.remove();
        }
    }

    // ---------------------------------
    // POPUP UI
    // ---------------------------------

    function createPopup() {

        if (popupWindow && !popupWindow.closed) {
            popupWindow.focus();
            return;
        }

        popupWindow = window.open(
            "",
            "STEventDebugger",
            "width=600,height=720,left=50,top=50"
        );

        if (!popupWindow) {
            toastr.error("Popup blocked");
            return;
        }

        popupWindow.document.write(`
<html>
<head>
<title>ST Event Debugger</title>

<style>
body { background:#111; color:white; font-family:monospace; margin:0; }

#header {
    position:sticky;
    top:0;
    background:#222;
    padding:10px;
    font-weight:bold;
    border-bottom:1px solid #444;
}

#tabs {
    display:flex;
    background:#1a1a1a;
}

.tab {
    flex:1;
    padding:8px;
    text-align:center;
    cursor:pointer;
}

.tab.active {
    border-bottom:2px solid #4fc3f7;
}

.panel {
    display:none;
    padding:10px;
}

.panel.active {
    display:block;
}

.event {
    margin-bottom:12px;
    padding-bottom:10px;
    border-bottom:1px solid rgba(255,255,255,0.08);
}

.name { color:#4fc3f7; font-weight:bold; }
.time { color:#999; margin-bottom:4px; }

details.payload {
    margin-top:6px;
}

summary {
    cursor:pointer;
    color:#aaa;
}

pre {
    white-space:pre-wrap;
    word-break:break-word;
    margin:6px 0 0 0;
}

.checkbox {
    margin:6px 0;
}
</style>

</head>

<body>

<div id="header">ST Event Debugger</div>

<div id="tabs">
    <div class="tab active" id="tab_logs">Logs</div>
    <div class="tab" id="tab_filters">Filters</div>
</div>

<div id="panel_logs" class="panel active">
    <div id="log"></div>
</div>

<div id="panel_filters" class="panel">
    <div id="filterList"></div>
</div>

</body>
</html>
        `);

        popupWindow.document.close();

        logContainer = popupWindow.document.getElementById("log");

        setupTabs();
        buildFilterList();

        logEvent("POPUP_CREATED", {});
    }

    // ---------------------------------
    // TABS
    // ---------------------------------

    function setupTabs() {

        const tabLogs = popupWindow.document.getElementById("tab_logs");
        const tabFilters = popupWindow.document.getElementById("tab_filters");

        const panelLogs = popupWindow.document.getElementById("panel_logs");
        const panelFilters = popupWindow.document.getElementById("panel_filters");

        tabLogs.onclick = () => {
            tabLogs.classList.add("active");
            tabFilters.classList.remove("active");
            panelLogs.classList.add("active");
            panelFilters.classList.remove("active");
        };

        tabFilters.onclick = () => {
            tabFilters.classList.add("active");
            tabLogs.classList.remove("active");
            panelFilters.classList.add("active");
            panelLogs.classList.remove("active");
        };
    }

    // ---------------------------------
    // FILTER UI
    // ---------------------------------

    function buildFilterList() {

        const container = popupWindow.document.getElementById("filterList");
        container.innerHTML = "";

        const events = Object.values(event_types).filter(Boolean);

        for (const ev of events) {

            const row = popupWindow.document.createElement("div");
            row.className = "checkbox";

            const checked = !hiddenPayloadEvents.has(ev);

            row.innerHTML = `
                <label>
                    <input type="checkbox" ${checked ? "checked" : ""}>
                    ${ev}
                </label>
            `;

            const cb = row.querySelector("input");

            cb.onchange = () => {
                if (cb.checked) hiddenPayloadEvents.delete(ev);
                else hiddenPayloadEvents.add(ev);
            };

            container.appendChild(row);
        }
    }

    // ---------------------------------
    // FULL EVENT COVERAGE
    // ---------------------------------

    for (const ev of Object.values(event_types)) {

        if (!ev) continue;

        eventSource.on(ev, data => {
            logEvent(ev, data);
        });
    }

    // ---------------------------------
    // STREAM (FIRST + LAST ONLY)
    // ---------------------------------

    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, data => {

        lastStreamTokenData = data;

        if (!streamFirstTokenSeen) {

            streamFirstTokenSeen = true;

            const raw =
                typeof data === "string"
                    ? data
                    : (data?.text || JSON.stringify(data));

            logEvent("STREAM_FIRST_TOKEN", {
                redacted: redactStream(raw)
            });

            return;
        }

        if (!streamHasLoggedMid) {

            streamHasLoggedMid = true;

            logEvent("STREAM_MID_TOKENS", { preview: "..." });
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, () => {

        if (lastStreamTokenData) {

            const raw =
                typeof lastStreamTokenData === "string"
                    ? lastStreamTokenData
                    : (lastStreamTokenData?.text || JSON.stringify(lastStreamTokenData));

            logEvent("STREAM_LAST_TOKEN", {
                redacted: redactStream(raw)
            });
        }

        streamFirstTokenSeen = false;
        streamHasLoggedMid = false;
        lastStreamTokenData = null;
    });

    // ---------------------------------
    // MESSAGE LENGTH (ONLY ON CHANGE)
    // ---------------------------------

    let lastMessageLength = null;

    function getLastMessageLength() {
        const msgs = document.querySelectorAll(".mes .mes_text");
        const last = msgs[msgs.length - 1];
        return last?.innerText?.length ?? null;
    }

    setInterval(() => {

        const len = getLastMessageLength();

        if (len == null) return;

        if (len !== lastMessageLength) {

            logEvent("LAST_MESSAGE_LENGTH", {
                chars: len,
                delta: lastMessageLength == null ? 0 : len - lastMessageLength
            });

            lastMessageLength = len;
        }

    }, 1000);

    // ---------------------------------
    // EDIT TRACKING
    // ---------------------------------

    let wasEditing = false;

    setInterval(() => {

        const textarea = document.querySelector(".mes_edit_textarea");
        const saveBtn = document.querySelector(".mes_edit_done");
        const cancelBtn = document.querySelector(".mes_edit_cancel");

        const editing = !!textarea;

        if (editing && !wasEditing) {
            wasEditing = true;
            logEvent("DOM_MESSAGE_EDIT_STARTED", { text: textarea?.value });
        }

        if (saveBtn && !saveBtn.dataset.hooked) {
            saveBtn.dataset.hooked = "1";
            saveBtn.addEventListener("click", () => {
                logEvent("DOM_MESSAGE_EDIT_SAVED", { text: textarea?.value });
            });
        }

        if (cancelBtn && !cancelBtn.dataset.hooked) {
            cancelBtn.dataset.hooked = "1";
            cancelBtn.addEventListener("click", () => {
                logEvent("DOM_MESSAGE_EDIT_CANCELLED", {});
            });
        }

        if (!editing) wasEditing = false;

    }, 500);

    // ---------------------------------
    // SEND BUTTON
    // ---------------------------------

    let lastSendState = null;

    setInterval(() => {

        const btn = document.querySelector("#send_but");
        if (!btn) return;

        const icon = btn.querySelector("i");
        const cls = icon?.className || "";

        const state = cls.includes("paper-plane") ? "READY" : "BUSY";

        if (state !== lastSendState) {
            lastSendState = state;
            logEvent("SEND_BUTTON_STATE", { state });
        }

    }, 1000);

    // ---------------------------------
    // SWIPES
    // ---------------------------------

    function observeSwipes() {

        const observer = new MutationObserver(() => {

            document.querySelectorAll(".mes").forEach(mes => {

                const id = getMessageId(mes);
                if (!id) return;

                const controls = mes.querySelector(".mes_swipe_controls");
                const has = !!controls;

                const prev = messageSwipeState.get(id) || {
                    active: false,
                    history: []
                };

                if (has && !prev.active) {
                    prev.active = true;
                    prev.history.push({ type: "ADDED", time: Date.now() });
                    logEvent("SWIPE_BUTTONS_ADDED", { messageId: id });
                }

                if (!has && prev.active) {
                    prev.active = false;
                    prev.history.push({ type: "REMOVED", time: Date.now() });
                    logEvent("SWIPE_BUTTONS_REMOVED", { messageId: id });
                }

                messageSwipeState.set(id, prev);
            });

        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true
        });

        logEvent("SWIPE_OBSERVER_STARTED", {});
    }

    // ---------------------------------
    // COPY TRACKING
    // ---------------------------------

    function observeCopyActions() {

        document.addEventListener("click", (e) => {

            const copyBtn = e.target.closest(".mes_copy, .copy_mes_button, .mes-button-copy");

            if (copyBtn) {
                const mes = copyBtn.closest(".mes");
                logEvent("MESSAGE_COPY_CLICKED", {
                    messageId: getMessageId(mes)
                });
            }

            const confirmBtn = e.target.closest(".popup-button-confirm, .ui-button-confirm, .confirm_button");

            if (confirmBtn) {
                logEvent("MESSAGE_COPY_CONFIRMED", { context: "dialog" });
            }

        }, true);

        logEvent("COPY_OBSERVER_STARTED", {});
    }

    // ---------------------------------
    // COMMANDS
    // ---------------------------------

    function registerCommands() {

        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: "swipe-log",
                helpString: "Dump swipe history",
                callback: () => {

                    const dump = [];

                    for (const [id, state] of messageSwipeState.entries()) {
                        dump.push({ messageId: id, ...state });
                    }

                    logEvent("SWIPE_DUMP", dump);
                    return "";
                }
            })
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: "ler-viewer",
                helpString: "Open event debugger popup",
                callback: () => {
                    createPopup();
                    observeSwipes();
                    observeCopyActions();
                    return "";
                }
            })
        );
    }

    setTimeout(registerCommands, 1000);

});
