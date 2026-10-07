import { Input } from "antd";
import { useState } from "react";
import build from "../../generated/build-info.json";
import "./AboutPanel.css";

type Notice = {
  name: string;
  version: string;
  license: string;
  texts: Array<{ file: string; text: string }>;
};
export type AboutLabels = {
  title: string;
  version: string;
  license: string;
  notices: string;
  search: string;
  loading: string;
  failed: string;
  empty: string;
  missingText: string;
};

export function AboutPanel({ labels }: { labels: AboutLabels }) {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const filtered = notices?.filter((notice) =>
    `${notice.name} ${notice.version} ${notice.license}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  async function load() {
    if (notices || loading) return;
    setLoading(true);
    setFailed(false);
    try {
      setNotices(
        (await import("../../generated/third-party-notices.json")).default,
      );
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="px-about" aria-labelledby="px-about-title">
      <h2 id="px-about-title" className="visually-hidden">
        {labels.title}
      </h2>
      <dl className="px-about-version">
        <dt>{labels.version}</dt>
        <dd>{build.version}</dd>
      </dl>
      <details className="px-about-license">
        <summary>
          {labels.license} · {build.license}
        </summary>
        <pre tabIndex={0} aria-label={`${build.name} ${labels.license}`}>
          {build.text}
        </pre>
      </details>
      <details
        className="px-about-notices"
        onToggle={(event) => {
          if (event.currentTarget.open) void load();
        }}
      >
        <summary>{labels.notices}</summary>
        {loading ? (
          <p className="small" role="status">
            {labels.loading}
          </p>
        ) : null}
        {failed ? (
          <p className="small" role="alert">
            {labels.failed}
          </p>
        ) : null}
        {notices ? (
          <div className="px-about-browser">
            <div className="px-about-search">
              <Input
                allowClear
                value={query}
                placeholder={labels.search}
                aria-label={labels.search}
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="small" aria-live="polite">
                {filtered?.length} / {notices.length}
              </span>
            </div>
            {filtered?.length ? (
              <ul className="px-about-packages">
                {filtered.map((notice) => (
                  <LicenseNotice
                    key={`${notice.name}@${notice.version}`}
                    notice={notice}
                    labels={labels}
                  />
                ))}
              </ul>
            ) : (
              <p className="small">{labels.empty}</p>
            )}
          </div>
        ) : null}
      </details>
    </section>
  );
}

function LicenseNotice({
  notice,
  labels,
}: {
  notice: Notice;
  labels: AboutLabels;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="px-about-package-name">
            {notice.name} <span>{notice.version}</span>
          </span>
          <span className="px-about-package-license">{notice.license}</span>
        </summary>
        {open ? (
          notice.texts.length ? (
            notice.texts.map((file) => (
              <div key={file.file} className="px-about-license-file">
                <h3 className="small">{file.file}</h3>
                <pre
                  tabIndex={0}
                  aria-label={`${notice.name} ${labels.license} ${file.file}`}
                >
                  {file.text}
                </pre>
              </div>
            ))
          ) : (
            <p className="small">{labels.missingText}</p>
          )
        ) : null}
      </details>
    </li>
  );
}
