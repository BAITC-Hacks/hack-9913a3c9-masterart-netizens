export function NodeLink({ gid, onSelectNode }: { gid: string; onSelectNode: (gid: string) => void }) {
  return <button type="button" className="fa-node" onClick={() => onSelectNode(gid)} aria-label={`Открыть счёт ${gid} на карте`}>
    <span className="fa-gid" dir="ltr">{gid}</span><span aria-hidden="true">↗</span>
  </button>;
}
