"use client";

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// /chat — mobile-first chat against the vault. One rolling thread per device
// (threadId in localStorage); "New" starts a fresh thread. Talks to
// /api/chat, which resumes the thread's Claude session and mirrors every turn
// into the vault. Plain-text rendering for now.
// ponytail: no markdown renderer (white-space: pre-wrap is enough); no token
// streaming yet (route returns the full reply). Add either when the wait bites.
// ---------------------------------------------------------------------------

type Msg = { role: "you" | "helm"; text: string };
const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-opus-4-8", label: "Opus" },
];

export default function ChatPage() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setThreadId(localStorage.getItem("helm.chat.thread"));
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  function newThread() {
    localStorage.removeItem("helm.chat.thread");
    setThreadId(null);
    setMessages([]);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "you", text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, message: text, model }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: "helm", text: `⚠ ${data.error ?? res.statusText}` }]);
      } else {
        if (data.threadId && data.threadId !== threadId) {
          setThreadId(data.threadId);
          localStorage.setItem("helm.chat.thread", data.threadId);
        }
        setMessages((m) => [...m, { role: "helm", text: data.reply }]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "helm", text: `⚠ ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat">
      <header>
        <span className="title">H.E.L.M. · CHAT</span>
        <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button onClick={newThread} title="new thread">
          NEW
        </button>
      </header>

      <main>
        {messages.length === 0 && (
          <p className="hint">Ask anything — it reads and writes your vault. Morphy is read-only for now.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="who">{m.role === "you" ? "YOU" : "HELM"}</span>
            <div className="text">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="msg helm">
            <span className="who">HELM</span>
            <div className="text dots">…thinking</div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <footer>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message HELM…"
          rows={1}
        />
        <button onClick={send} disabled={busy || !input.trim()}>
          SEND
        </button>
      </footer>

      <style jsx>{`
        .chat {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          background: var(--bg);
          color: var(--ink);
          font-family: var(--font-mono), monospace;
          font-size: 13px;
        }
        header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--line);
        }
        .title {
          flex: 1;
          font-family: var(--font-display), sans-serif;
          letter-spacing: 0.12em;
          color: var(--ember);
        }
        header select,
        header button,
        footer button {
          background: transparent;
          color: var(--ink-dim);
          border: 1px solid var(--line);
          border-radius: 4px;
          padding: 5px 9px;
          font: inherit;
          font-size: 11px;
          letter-spacing: 0.08em;
          cursor: pointer;
        }
        header button:active,
        footer button:active {
          color: var(--ember);
        }
        main {
          flex: 1;
          overflow-y: auto;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          -webkit-overflow-scrolling: touch;
        }
        .hint {
          color: var(--ink-faint);
          margin: auto;
          text-align: center;
          max-width: 280px;
          line-height: 1.5;
        }
        .msg {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .msg.you {
          align-items: flex-end;
        }
        .who {
          font-size: 9px;
          letter-spacing: 0.15em;
          color: var(--ink-faint);
        }
        .text {
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.55;
          max-width: 88%;
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--line-faint);
        }
        .msg.you .text {
          background: var(--ember-deep);
          border-color: transparent;
          color: var(--white-hot);
        }
        .msg.helm .text {
          background: hsl(var(--accent-h) 20% 18% / 0.4);
        }
        .dots {
          color: var(--ink-faint);
        }
        footer {
          display: flex;
          gap: 8px;
          padding: 12px 14px calc(12px + env(safe-area-inset-bottom));
          border-top: 1px solid var(--line);
        }
        footer textarea {
          flex: 1;
          resize: none;
          max-height: 120px;
          background: hsl(var(--accent-h) 20% 18% / 0.4);
          color: var(--ink);
          border: 1px solid var(--line);
          border-radius: 8px;
          padding: 10px 12px;
          font: inherit;
          font-size: 16px; /* >=16px stops iOS Safari zoom-on-focus */
          line-height: 1.4;
        }
        footer textarea:focus {
          outline: none;
          border-color: var(--ember);
        }
        footer button {
          align-self: flex-end;
          padding: 11px 14px;
        }
        footer button:disabled {
          opacity: 0.4;
        }
      `}</style>
    </div>
  );
}
