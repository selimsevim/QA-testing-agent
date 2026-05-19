import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { InboxItem, InboxMessageDetail, InboxResponse } from '../types';

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString();
  } catch {
    return s;
  }
}

function shortenFrom(s: string): string {
  const m = s.match(/^([^<]+)</);
  return m ? m[1].trim() : s;
}

export function InboxView({ onUnreadChange }: { onUnreadChange?: (n: number) => void }) {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxMessageDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.inbox();
      setData(r);
      onUnreadChange?.(r.unreadCount);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openMessage(id: string) {
    if (openId === id) {
      // Toggle close on same row
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    setDetailError(null);
    setDetailBusy(true);
    try {
      const m = await api.inboxMessage(id);
      setDetail(m);
    } catch (e) {
      setDetailError((e as Error).message);
    } finally {
      setDetailBusy(false);
    }
  }

  useEffect(() => {
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="work-head">
        <div>
          <div className="crumb">Workspace <b>/</b> Inbox</div>
          <h1>Gmail Inbox</h1>
          <p className="sub">
            Live view of the seed inbox. Click any row to preview the email and click its links — judges can verify deliveries and destinations without leaving the app.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={busy} style={{ flex: 'none' }}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Recent messages</h2>
          <span className="hint">
            {data ? `${data.items.length} shown · ${data.unreadCount} unread` : busy ? 'Loading…' : error ? 'Error' : ''}
          </span>
        </div>
        {error && (
          <div className="card-body" style={{ color: 'var(--red)' }}>
            Could not load inbox: {error}. Make sure Gmail is connected with the gmail.modify scope (the rail will say "Reconnect" if not).
          </div>
        )}
        {!error && (
          <div className="table-wrap">
            <table className="inbox-table">
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th style={{ width: 180 }}>From</th>
                  <th>Subject</th>
                  <th style={{ width: 180 }}>To</th>
                  <th style={{ width: 170 }}>Received</th>
                </tr>
              </thead>
              <tbody>
                {!data ? (
                  <tr>
                    <td colSpan={5} className="empty-row">Loading…</td>
                  </tr>
                ) : data.items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-row">No recent messages.</td>
                  </tr>
                ) : (
                  data.items.map((it) => (
                    <InboxRow
                      key={it.id}
                      item={it}
                      open={openId === it.id}
                      detail={openId === it.id ? detail : null}
                      detailBusy={openId === it.id ? detailBusy : false}
                      detailError={openId === it.id ? detailError : null}
                      onToggle={() => openMessage(it.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function InboxRow({
  item,
  open,
  detail,
  detailBusy,
  detailError,
  onToggle,
}: {
  item: InboxItem;
  open: boolean;
  detail: InboxMessageDetail | null;
  detailBusy: boolean;
  detailError: string | null;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={item.unread ? 'inbox-row inbox-unread' : 'inbox-row'}
        onClick={onToggle}
        style={{ cursor: 'pointer' }}
      >
        <td>{item.unread ? <span className="unread-dot" title="Unread" /> : null}</td>
        <td title={item.from}>{shortenFrom(item.from)}</td>
        <td>
          <div className="inbox-subject">{item.subject}</div>
          <div className="inbox-snippet">{item.snippet}</div>
        </td>
        <td className="mono-cell" title={item.to}>{item.to}</td>
        <td className="mono-cell">{fmtDate(item.date)}</td>
      </tr>
      {open && (
        <tr className="inbox-detail-row">
          <td colSpan={5}>
            <div className="inbox-detail">
              <div className="inbox-detail-head">
                <div className="inbox-detail-meta">
                  <div><span className="mk">Subject:</span> {item.subject}</div>
                  <div><span className="mk">From:</span> {item.from}</div>
                  <div><span className="mk">To:</span> {item.to}</div>
                  <div><span className="mk">Received:</span> {fmtDate(item.date)}</div>
                </div>
                <a
                  className="inbox-detail-gmail"
                  href={`https://mail.google.com/mail/u/0/#all/${item.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Gmail ↗
                </a>
              </div>
              {detailBusy && <div className="inbox-detail-busy">Loading email content…</div>}
              {detailError && <div className="inbox-detail-error">Could not load: {detailError}</div>}
              {detail && (detail.htmlBody || detail.textBody) && (
                <InboxEmailFrame html={detail.htmlBody} text={detail.textBody} title={item.subject} />
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Sandboxed iframe with allow-popups so anchors can open in a new tab when clicked.
// We inject <base target="_blank"> so any anchor without an explicit target opens
// in a new window. Scripts inside the email cannot execute (no allow-scripts).
function InboxEmailFrame({ html, text, title }: { html: string; text: string; title: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null);

  function resize() {
    const f = ref.current;
    if (!f) return;
    try {
      const doc = f.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.body?.scrollHeight || 0, doc.documentElement?.scrollHeight || 0, 360);
      f.style.height = `${Math.min(h + 4, 2400)}px`;
    } catch {
      /* sandbox isolates document on some browsers */
    }
  }

  if (!html) {
    return <pre className="inbox-detail-text">{text}</pre>;
  }

  // Wrap the raw HTML with a <base target="_blank"> so anchor clicks open in
  // a new tab, and a small reset so the email's background extends edge-to-edge.
  const srcDoc = `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"></head><body style="margin:0">${html}</body></html>`;

  return (
    <iframe
      ref={ref}
      className="inbox-detail-frame"
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={title}
      loading="lazy"
      onLoad={resize}
    />
  );
}
