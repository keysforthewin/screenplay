import { useEffect, useRef, useState } from 'react';
import { ArtworkDialog } from './ArtworkDialog.jsx';
import { ArtworkEditDialog } from './ArtworkEditDialog.jsx';
import { ArtworkPickerModal } from './ArtworkPickerModal.jsx';
import { ImageSheetDialog } from './ImageSheetDialog.jsx';
import { GenerationProgress } from './GenerationProgress.jsx';
import { apiDelete, apiGet, apiPatchJson, apiPostJson, imageUrl, thumbUrl } from '../api.js';

// Generalized artwork tab — works for both character and beat hosts.
// Renders host.artworks[] as a grid. Each tile shows the artwork's name
// (falling back to a truncated prompt), the result image (or a spinner
// when status='pending', or an error banner when status='error'), and a
// row of actions: Edit (Nano Banana Pro inline), Regenerate, Download,
// Delete. Names are click-to-edit inline.
//
// Generation is async on the backend: clicking "+ New artwork" or
// regenerate posts to the host's route which immediately returns a
// pending artwork; the SPA re-renders showing the spinner; the result
// arrives via the Hocuspocus fields_updated broadcast (CollabSurface).
//
// Props:
//   hostType: 'character' | 'beat'
//   hostId:   24-hex id string
//   hostLabel: optional display label for the host (used by picker tabs)
//   artworks: host.artworks[]
//   hostImages: reference candidates for the picker (host's images[])
//   hostArtworks: optional — host's other artworks (used in picker filtering)
//   onChange: callback that refreshes the host data (passed to dialogs)
export function ArtworkTab({
  hostType,
  hostId,
  hostLabel,
  artworks,
  hostImages = [],
  hostArtworks = [],
  mainImageId = null,
  mainPath = null,
  onChange,
}) {
  const [creating, setCreating] = useState(false);
  const [regenerating, setRegenerating] = useState(null); // artwork doc
  const [editing, setEditing] = useState(null); // artwork doc for in-line edit
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [renameId, setRenameId] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  // Multi-select for bulk delete on the gallery.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Image-sheet batch job: lives here (not in the dialog) so progress survives
  // the dialog closing on start. The job runs server-side regardless; this only
  // tracks the aggregate progress panel.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetJob, setSheetJob] = useState(null);
  const [sheetJobErr, setSheetJobErr] = useState(null);
  const [showSheetLog, setShowSheetLog] = useState(false);
  const sheetPollRef = useRef(null);
  const sheetLogRef = useRef(null);

  const basePath = `/${hostType}/${hostId}`;

  const sheetActive = !!sheetJob && !['done', 'partial', 'error'].includes(sheetJob.status);

  function stopSheetPoll() {
    if (sheetPollRef.current) {
      clearInterval(sheetPollRef.current);
      sheetPollRef.current = null;
    }
  }

  // Poll the global image-sheet job endpoint, refreshing the host each tick so
  // the pending artwork tiles fill in live alongside the aggregate panel.
  async function pollSheet(jobId) {
    try {
      const r = await apiGet(`/image-sheet/${jobId}`);
      const job = r?.job ?? r;
      setSheetJob(job);
      if (job && ['done', 'partial', 'error'].includes(job.status)) {
        stopSheetPoll();
        if (job.status === 'error') setSheetJobErr(job.error || 'Image sheet failed.');
      }
      await onChange?.();
    } catch {
      // transient poll error — keep polling (the job runs server-side regardless)
    }
  }

  function startSheetJob({ jobId, planned }) {
    stopSheetPoll();
    setSheetJobErr(null);
    setShowSheetLog(true);
    setSheetJob({
      status: 'queued',
      completed: 0,
      failed: 0,
      planned: planned || 0,
      started_at: new Date().toISOString(),
    });
    sheetPollRef.current = setInterval(() => pollSheet(jobId), 2000);
    pollSheet(jobId);
  }

  // Clear the poll interval on unmount (e.g. navigating away mid-job).
  useEffect(() => () => stopSheetPoll(), []);

  const sorted = [...(artworks || [])].sort((a, b) => {
    const aTime = +new Date(a.updated_at || a.created_at || 0);
    const bTime = +new Date(b.updated_at || b.created_at || 0);
    return bTime - aTime;
  });

  async function remove(id) {
    if (!confirm('Delete this artwork? Its result image will be removed too.')) return;
    setBusyId(id);
    setError(null);
    try {
      await apiDelete(`${basePath}/artwork/${id}`);
      await onChange?.();
    } catch (e) {
      setError(e?.message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Bulk-delete the checked artworks. Reuses the per-artwork DELETE endpoint in
  // sequence (each purges its GridFS images + broadcasts) — fine for the handful
  // a user selects; failures are tallied rather than aborting the batch.
  async function bulkDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} artwork${ids.length === 1 ? '' : 's'}? Their result images will be removed too.`)) return;
    setBulkBusy(true);
    setError(null);
    let failed = 0;
    for (const id of ids) {
      try {
        await apiDelete(`${basePath}/artwork/${id}`);
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    setSelectedIds(new Set());
    if (failed) setError(`${failed} of ${ids.length} could not be deleted.`);
    await onChange?.();
  }

  async function retry(art) {
    // Errored artwork: re-kick the same job via regenerate using the stored
    // prompt/model/refs. Convenient single-click recovery.
    setBusyId(art._id?.toString?.());
    setError(null);
    try {
      await apiPostJson(`${basePath}/artwork/${art._id}/regenerate`, {
        prompt: art.prompt || '',
        model: art.model || 'fal',
        reference_image_ids: (art.reference_image_ids || []).map(String),
        name: art.name || '',
      });
      await onChange?.();
    } catch (e) {
      setError(e?.message || 'Retry failed');
    } finally {
      setBusyId(null);
    }
  }

  function startRename(art) {
    setRenameId(art._id?.toString?.() || String(art._id));
    setRenameValue(art.name || '');
  }

  async function setAsMain(resultId) {
    if (!mainPath || !resultId) return;
    try {
      await apiPostJson(mainPath, { image_id: resultId });
      await onChange?.();
    } catch (e) {
      setError(e?.message || 'Set main failed');
    }
  }

  const mainIdStr = mainImageId?.toString?.()
    || (typeof mainImageId === 'string' ? mainImageId : null);

  async function commitRename() {
    if (!renameId) return;
    const id = renameId;
    const value = renameValue;
    setRenameId(null);
    setRenameValue('');
    try {
      await apiPatchJson(`${basePath}/artwork/${id}`, { name: value });
      await onChange?.();
    } catch (e) {
      setError(e?.message || 'Rename failed');
    }
  }

  // Re-read the latest artwork from props each render so the edit dialog
  // reflects status transitions (pending → done) without polling.
  function latestArtwork(target) {
    if (!target) return null;
    const targetId = target._id?.toString?.() || String(target._id);
    return (
      (artworks || []).find(
        (a) => (a._id?.toString?.() || String(a._id)) === targetId,
      ) || target
    );
  }

  return (
    <div className="artwork-tab">
      <p className="tab-intro">
        Artwork is generated from a prompt plus reference images. Pick refs
        from this {hostType} or any beat. Each tile can be edited in-line
        (Nano Banana Pro single-step tweaks with one undo), fully regenerated,
        renamed, or deleted.
      </p>
      <div className="tab-actions">
        <button
          type="button"
          className="primary"
          onClick={() => setCreating(true)}
        >
          + New artwork
        </button>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          disabled={sheetActive}
          title={sheetActive ? 'An image sheet is already generating' : undefined}
        >
          Create image sheet
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {sheetJobErr && (
        <div className="error-banner">Image sheet error: {sheetJobErr}</div>
      )}
      {sheetJob && (
        <div className="image-sheet-progress">
          <GenerationProgress
            job={sheetJob}
            noun="shot"
            showLog={showSheetLog}
            onToggleLog={() => setShowSheetLog((s) => !s)}
            logRef={sheetLogRef}
          />
          {!sheetActive && (
            <div className="tab-actions">
              <button
                type="button"
                onClick={() => { setSheetJob(null); setSheetJobErr(null); }}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div className="artwork-bulk-bar">
          <span>{selectedIds.size} selected</span>
          <button type="button" className="primary" onClick={bulkDelete} disabled={bulkBusy}>
            {bulkBusy ? 'Deleting…' : `Delete ${selectedIds.size} selected`}
          </button>
          <button type="button" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy}>
            Clear
          </button>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="artwork-empty">
          No artwork yet. Click "+ New artwork" to generate the first piece.
        </div>
      ) : (
        <div className="artwork-grid">
          {sorted.map((art) => {
            const id = art._id?.toString?.() || String(art._id);
            const resultId = art.result_image_id?.toString?.()
              || (art.result_image_id ? String(art.result_image_id) : null);
            const isBusy = busyId === id;
            const status = art.status || (resultId ? 'done' : 'pending');
            const selected = selectedIds.has(id);
            return (
              <div key={id} className={`artwork-card artwork-card-${status}${selected ? ' is-selected' : ''}`}>
                <label className="artwork-select" title="Select for bulk delete">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelect(id)}
                  />
                </label>
                <div className="artwork-thumb">
                  {resultId ? (
                    <a
                      href={imageUrl(resultId)}
                      target="_blank"
                      rel="noreferrer"
                      title="Open full size in new tab"
                    >
                      <img src={thumbUrl(resultId)} alt="" loading="lazy" />
                    </a>
                  ) : (
                    <div className="artwork-thumb-empty">
                      {status === 'pending' ? 'Generating…' : '(no result)'}
                    </div>
                  )}
                  {status === 'pending' && (
                    <div className="artwork-thumb-overlay">
                      <div className="spinner" />
                      <span>Generating…</span>
                    </div>
                  )}
                  {status === 'error' && (
                    <div className="artwork-thumb-overlay is-error">
                      <span>Failed</span>
                    </div>
                  )}
                </div>
                <div className="artwork-card-body">
                  <div className="artwork-card-name">
                    {renameId === id ? (
                      <input
                        type="text"
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename();
                          if (e.key === 'Escape') {
                            setRenameId(null);
                            setRenameValue('');
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="artwork-card-name-btn"
                        title="Click to rename"
                        onClick={() => startRename(art)}
                      >
                        {art.name || <em>(unnamed)</em>}
                      </button>
                    )}
                  </div>
                  <div className="artwork-card-prompt">
                    {(art.prompt || '').slice(0, 140)
                      || <em>(no prompt)</em>}
                    {(art.prompt || '').length > 140 ? '…' : ''}
                  </div>
                  {status === 'error' && (
                    <div className="artwork-card-error">
                      {art.error_message || 'Generation failed.'}
                    </div>
                  )}
                  <div className="artwork-card-actions">
                    {resultId && status === 'done' && mainPath && (
                      resultId === mainIdStr ? (
                        <span
                          className="is-main-badge"
                          style={{ color: 'var(--accent)', fontSize: 12 }}
                        >
                          ★ main
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setAsMain(resultId)}
                          disabled={isBusy}
                          title="Use this artwork as the main thumbnail"
                        >
                          Set as main
                        </button>
                      )
                    )}
                    {resultId && status === 'done' && (
                      <button
                        type="button"
                        onClick={() => setEditing(art)}
                        disabled={isBusy}
                        title="In-line edit with Nano Banana Pro"
                      >
                        Edit
                      </button>
                    )}
                    {status === 'done' && (
                      <button
                        type="button"
                        onClick={() => setRegenerating(art)}
                        disabled={isBusy}
                      >
                        Regenerate
                      </button>
                    )}
                    {status === 'error' && (
                      <button
                        type="button"
                        onClick={() => retry(art)}
                        disabled={isBusy}
                      >
                        {isBusy ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => remove(id)}
                      disabled={isBusy}
                    >
                      {isBusy ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ArtworkPickerModal
        open={creating}
        onClose={() => setCreating(false)}
        onDone={onChange}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
      />

      <ImageSheetDialog
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onStarted={startSheetJob}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
      />

      <ArtworkDialog
        open={regenerating != null}
        onClose={() => setRegenerating(null)}
        onDone={onChange}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        artwork={regenerating}
      />

      <ArtworkEditDialog
        open={editing != null}
        onClose={() => setEditing(null)}
        onDone={onChange}
        hostType={hostType}
        hostId={hostId}
        hostLabel={hostLabel}
        hostImages={hostImages}
        hostArtworks={hostArtworks}
        artwork={latestArtwork(editing)}
      />
    </div>
  );
}

export { imageUrl };
