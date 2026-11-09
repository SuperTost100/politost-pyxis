import "./Skeleton.css";

const WIDTHS = [[42, 68], [34, 58], [48, 62], [38, 54]] as const;

/**
 * A quick load from this computer, drawn as rows in the shape of the list that is coming. It shows only after 150 ms,
 * so a fast load never flashes it. AI work never gets one: it gets `Working`.
 */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div className="px-skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => {
        const [title, line] = WIDTHS[index % WIDTHS.length]!;
        return (
          <div className="px-skeleton-row" key={index} aria-hidden>
            <i className="px-skeleton-bar is-title" style={{ width: `${title}%` }} />
            <i className="px-skeleton-bar" style={{ width: `${line}%` }} />
          </div>
        );
      })}
    </div>
  );
}
