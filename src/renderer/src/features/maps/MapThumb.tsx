/** A path from (x1, y1) to (x2, y2) that turns twice with rounded corners, as the tree layout's links do. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const middle = (x1 + x2) / 2;
  const rise = y2 - y1;
  if (Math.abs(rise) < 1) return `M${x1},${y1} H${x2}`;
  const radius = Math.min(5, Math.abs(rise) / 2);
  const sign = Math.sign(rise);
  return (
    `M${x1},${y1} H${middle - radius} Q${middle},${y1} ${middle},${y1 + sign * radius} ` +
    `V${y2 - sign * radius} Q${middle},${y2} ${middle + radius},${y2} H${x2}`
  );
}

const WIDTH = 300;
const HEIGHT = 150;

/**
 * A small drawing of a map for its tile (pyxis-mockups app/index.html, the Mappe tiles): the root on the left, its
 * branches, and the concepts on each branch, laid out left to right as the tree layout draws them. `shape` holds how
 * many concepts hang off each branch.
 */
export function MapThumb({ shape }: { shape: number[] }) {
  const rows = shape.reduce((sum, leaves) => sum + Math.max(1, leaves), 0);
  const rowHeight = rows ? Math.min(20, (HEIGHT - 24) / rows) : 0;
  const paths: string[] = [];
  const boxes: Array<{ x: number; y: number; width: number; height: number; root?: boolean }> = [
    { x: 24, y: HEIGHT / 2, width: 58, height: 18, root: true },
  ];
  let y = (HEIGHT - rows * rowHeight) / 2 + rowHeight / 2;
  shape.forEach((leaves, branch) => {
    const ys = Array.from({ length: Math.max(1, leaves) }, (_, index) => y + index * rowHeight);
    y += ys.length * rowHeight;
    const middle = (ys[0]! + ys.at(-1)!) / 2;
    paths.push(elbow(82, HEIGHT / 2, 112, middle));
    boxes.push({ x: 112, y: middle, width: 52, height: 12 });
    for (let leaf = 0; leaf < leaves; leaf += 1) {
      paths.push(elbow(164, middle, 194, ys[leaf]!));
      // Widths vary a little, as labels do, but the same map always draws the same.
      boxes.push({ x: 194, y: ys[leaf]!, width: 52 + ((branch * 31 + leaf * 17) % 31), height: 10 });
    }
  });
  // As wide as what it draws, so a map without concepts on its branches sits in the middle of the tile too.
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + 24;
  return (
    <svg className="px-map-thumb" viewBox={`0 0 ${Math.min(WIDTH, right)} ${HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
      {paths.map((d, index) => (
        <path key={`p${index}`} d={d} />
      ))}
      {boxes.map((box, index) => (
        <rect
          key={`r${index}`}
          className={box.root ? "is-root" : undefined}
          x={box.x}
          y={box.y - box.height / 2}
          width={box.width}
          height={box.height}
          rx={3.5}
        />
      ))}
    </svg>
  );
}
