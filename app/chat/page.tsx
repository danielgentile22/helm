"use client";

import { useEffect, useRef, useState } from "react";
import { helmKey } from "@/lib/helmKey";

// ---------------------------------------------------------------------------
// /chat — chat against the vault, now a tab inside the shell. One rolling
// thread per device (threadId in localStorage); "New" starts fresh. Talks to
// /api/chat, which resumes the thread's Claude session and mirrors every turn
// into the vault. Halo-styled; plain-text rendering for now.
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
  // bumped by newThread — an in-flight send from a previous generation drops
  // its reply instead of leaking it (and its threadId) into the fresh thread
  const genRef = useRef(0);

  useEffect(() => {
    setThreadId(localStorage.getItem("helm.chat.thread"));
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  function newThread() {
    genRef.current++;
    localStorage.removeItem("helm.chat.thread");
    setThreadId(null);
    setMessages([]);
    setBusy(false);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const gen = genRef.current;
    setInput("");
    setMessages((m) => [...m, { role: "you", text }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-HELM-KEY": await helmKey() },
        body: JSON.stringify({ threadId, message: text, model }),
      });
      const data = await res.json();
      if (gen !== genRef.current) return; // New was clicked mid-flight — this reply belongs to the abandoned thread
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
      if (gen === genRef.current) setMessages((m) => [...m, { role: "helm", text: `⚠ ${String(e)}` }]);
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <span className="chat-title">Chat</span>
        <select className="ta-select chat-model" value={model} onChange={(e) => setModel(e.target.value)} aria-label="model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={newThread} title="new thread">
          New
        </button>
      </header>

      <main className="chat-log">
        {messages.length === 0 && (
          <p className="chat-hint">Ask anything — it reads and writes your vault. Morphy is read-only for now.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <span className="who">{m.role === "you" ? "YOU" : "HELM"}</span>
            <div className="bubble">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="msg helm">
            <span className="who">HELM</span>
            <div className="bubble dots">…thinking</div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      <footer className="chat-compose">
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
        <button className="btn btn-primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </footer>

      <style jsx>{`
        .chat {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
        }
        .chat-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px clamp(16px, 3vw, 32px);
          border-bottom: 1px solid var(--color-border);
        }
        .chat-title {
          flex: 1;
          font-family: var(--font-head);
          font-weight: 600;
          font-size: 15px;
          letter-spacing: 0.02em;
          color: var(--color-text-primary);
        }
        .chat-model {
          width: auto;
          height: 32px;
          padding: 0 30px 0 12px;
        }
        .chat-log {
          flex: 1;
          overflow-y: auto;
          padding: 20px clamp(16px, 3vw, 32px);
          display: flex;
          flex-direction: column;
          gap: 16px;
          max-width: 820px;
          width: 100%;
          margin-inline: auto;
          -webkit-overflow-scrolling: touch;
        }
        .chat-hint {
          color: var(--color-text-muted);
          margin: auto;
          text-align: center;
          max-width: 320px;
          line-height: 1.6;
          font-size: 14px;
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
          font-size: 10px;
          letter-spacing: 0.12em;
          color: var(--color-text-muted);
        }
        .bubble {
          white-space: pre-wrap;
          word-break: break-word;
          line-height: 1.6;
          max-width: 84%;
          padding: 11px 14px;
          border-radius: var(--radius-lg);
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          color: var(--color-text-primary);
          font-size: 14px;
        }
        .msg.you .bubble {
          background: var(--color-primary);
          border-color: var(--color-primary);
          color: #fff;
        }
        .dots {
          color: var(--color-text-muted);
        }
        .chat-compose {
          display: flex;
          gap: 10px;
          align-items: flex-end;
          padding: 12px clamp(16px, 3vw, 32px) calc(14px + env(safe-area-inset-bottom));
          border-top: 1px solid var(--color-border);
          max-width: 820px;
          width: 100%;
          margin-inline: auto;
        }
        .chat-compose textarea {
          flex: 1;
          resize: none;
          max-height: 140px;
          background: var(--color-surface);
          color: var(--color-text-primary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: 10px 14px;
          font: inherit;
          font-size: 16px; /* >=16px stops iOS Safari zoom-on-focus */
          line-height: 1.4;
        }
        .chat-compose textarea:focus {
          outline: none;
          border-color: var(--color-primary);
          box-shadow: var(--focus-ring);
        }
        .chat-compose .btn {
          align-self: stretch;
        }
        @media (max-width: 768px) {
          .chat-compose {
            padding-bottom: calc(14px + 56px + env(safe-area-inset-bottom));
          }
        }
      `}</style>
    </div>
  );
}
