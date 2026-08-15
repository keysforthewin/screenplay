// Tab computation for SheetReferencePicker — pure functions over the /toc
// response, extracted so the backend Vitest suite can cover them without a
// JSX transform.
//
// Entity rosters in the TOC reference beats by order (no ids), so selected
// beat ids are mapped through toc.beats first.

function relevantOrders({ hostType, hostId, beatIds, toc }) {
  const orderById = new Map(
    (toc?.beats || []).map((b) => [String(b._id), b.order]),
  );
  if (hostType === 'character') {
    const host = (toc?.characters || []).find((c) => String(c._id) === String(hostId));
    return new Set((host?.beats || []).map((b) => b.order));
  }
  const ids = hostType === 'beat' ? [hostId] : beatIds || [];
  return new Set(
    ids.map((id) => orderById.get(String(id))).filter((o) => o != null),
  );
}

// Build the tab list: `{ id, label, isHost }`, host first (set/character
// hosts only — a beat host has no tab of its own), the rest ordered by their
// earliest beat shared with the relevant orders.
export function computeOwners({ hostType, hostId, hostLabel, beatIds, toc }) {
  const orders = relevantOrders({ hostType, hostId, beatIds, toc });
  const pool = hostType === 'character' ? toc?.characters || [] : toc?.sets || [];

  const others = pool
    .map((e) => {
      const shared = (e.beats || [])
        .map((b) => b.order)
        .filter((o) => orders.has(o));
      return { entity: e, firstOrder: shared.length ? Math.min(...shared) : null };
    })
    .filter((x) => x.firstOrder != null && String(x.entity._id) !== String(hostId))
    .sort((a, b) => a.firstOrder - b.firstOrder)
    .map((x) => ({
      id: String(x.entity._id),
      label: x.entity.plain_name || x.entity.name || '(unnamed)',
      isHost: false,
    }));

  if (hostType === 'beat') return others;

  const hostEntity = pool.find((e) => String(e._id) === String(hostId));
  const hostName = hostEntity?.plain_name || hostLabel || '';
  return [
    {
      id: String(hostId),
      label: hostName ? `This ${hostType} (${hostName})` : `This ${hostType}`,
      isHost: true,
    },
    ...others,
  ];
}
