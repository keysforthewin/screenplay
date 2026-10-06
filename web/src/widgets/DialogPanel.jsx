import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { apiDelete, apiGet, apiPatchJson, apiPostJson } from '../api.js';
import { CollabSurface } from '../editor/CollabSurface.jsx';
import { CollabField } from '../editor/CollabField.jsx';
import { DialogItem } from './DialogItem.jsx';
import { ConfirmDialog } from './Modal.jsx';
import { DialogEditDialog } from './DialogEditDialog.jsx';
import { DialogPerform } from './DialogPerform.jsx';
import { DialogVoicesBanner, GenerateVoicesDialog } from './DialogVoices.jsx';

// The Dialogue panel of the beat page (routes/Beat.jsx): the beat's dialogue
// lines over the dialogs:<beatId> room. The page mounts it on the first visit
// to the tab and keeps it mounted, hidden, afterwards; `active` says whether
// it is the tab on screen.
export function DialogPanel({ beat, toc, session, active = true }) {
  const beatKey = String(beat._id);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationStatus, setGenerationStatus] = useState(null);
  const pollRef = useRef(null);
  const justAddedRef = useRef(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [critiquing, setCritiquing] = useState(false);
  const [critiqueError, setCritiqueError] = useState(null);
  const [critiqueScores, setCritiqueScores] = useState(null);
  const [performing, setPerforming] = useState(false);
  const [preparingNotes, setPreparingNotes] = useState(false);
  const [prepareError, setPrepareError] = useState(null);

  // "Generate all voices" (ElevenLabs v4): the confirm dialog's counts and the
  // beat's batch, polled while it runs.
  const [voicePreview, setVoicePreview] = useState(null);
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceJob, setVoiceJob] = useState(null);
  const [voiceError, setVoiceError] = useState(null);
  const [dismissedVoiceJob, setDismissedVoiceJob] = useState(null);
  const voicePollRef = useRef(null);

  const characters = toc?.characters || [];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiGet(`/dialogs?beat_id=${encodeURIComponent(beatKey)}`);
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [beatKey, refreshKey]);

  const onRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const [localOrder, setLocalOrder] = useState(null);
  useEffect(() => {
    if (data?.dialogs) {
      setLocalOrder(data.dialogs.map((d) => d._id?.toString?.() || String(d._id)));
    }
  }, [data]);

  const dialogsById = useMemo(() => {
    const map = new Map();
    for (const d of data?.dialogs || []) {
      map.set(d._id?.toString?.() || String(d._id), d);
    }
    return map;
  }, [data]);

  const sortedItems = useMemo(() => {
    if (!localOrder) return [];
    return localOrder.map((id) => dialogsById.get(id)).filter(Boolean);
  }, [localOrder, dialogsById]);

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localOrder.indexOf(active.id);
    const newIndex = localOrder.indexOf(over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(localOrder, oldIndex, newIndex);
    setLocalOrder(next);
    try {
      await apiPostJson('/dialogs/reorder', {
        beat_id: data.beat._id,
        ordered_ids: next,
      });
      onRefresh();
    } catch (e) {
      setError(`Reorder failed: ${e.message}`);
      setLocalOrder(localOrder);
    }
  }

  async function addDialog() {
    try {
      const r = await apiPostJson('/dialogs', { beat_id: data.beat._id });
      const newId = r?.dialog?._id
        ? (r.dialog._id.toString?.() || String(r.dialog._id))
        : null;
      if (newId) setExpandedId(newId);
      justAddedRef.current = true;
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  async function deleteDialog(id) {
    if (!confirm('Delete this dialog item?')) return;
    try {
      await apiDelete(`/dialog/${id}`);
      const sid = id?.toString?.() || String(id);
      setExpandedId((cur) => (cur === sid ? null : cur));
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  }

  // Persist a character pick from the autocomplete. Errors propagate so
  // <CharacterSelect> can surface "no such character" inline; on success the
  // gateway's broadcast triggers an automatic refetch via onPing.
  async function setDialogCharacter(id, characterName) {
    await apiPatchJson(`/dialog/${id}`, { character: characterName });
  }

  async function pollJob(jobId) {
    try {
      const r = await apiGet(`/dialogs/generate/${jobId}`);
      setGenerationStatus(r.job);
      if (r.job?.status === 'done' || r.job?.status === 'error') {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setGenerating(false);
        if (r.job.status === 'error') {
          setGenerationError(r.job.error || 'Generation failed.');
        }
        onRefresh();
      } else {
        onRefresh();
      }
    } catch (e) {
      // Ignore transient errors; polling keeps trying.
    }
  }

  async function generate() {
    if (!data?.beat) return;
    setGenerating(true);
    setGenerationError(null);
    setGenerationStatus({ status: 'queued', extracted: 0, created: 0 });
    try {
      const r = await apiPostJson('/dialogs/generate', {
        beat_id: data.beat._id,
      });
      const jobId = r.job_id;
      pollRef.current = setInterval(() => pollJob(jobId), 2000);
      pollJob(jobId);
    } catch (e) {
      setGenerating(false);
      setGenerationError(e.message);
    }
  }

  function onGenerateClick() {
    if (sortedItems.length > 0) {
      setConfirmGenerate(true);
    } else {
      generate();
    }
  }

  async function critique() {
    if (!data?.beat) return;
    setCritiquing(true);
    setCritiqueError(null);
    try {
      const r = await apiPostJson('/dialogs/critique', { beat_id: data.beat._id });
      const map = new Map();
      for (const s of r.scores || []) {
        map.set(s.dialog_id, { score: s.score, issue: s.issue });
      }
      setCritiqueScores(map);
    } catch (e) {
      setCritiqueError(e.message);
    } finally {
      setCritiquing(false);
    }
  }

  async function deleteAll() {
    setDeleteAllError(null);
    try {
      await apiPostJson('/dialogs/clear', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setDeleteAllError(e.message);
    }
  }

  // Generate a performance "Direction" note for every line in this beat at once.
  // The notes land in each line's collaborative field; refetch so button labels
  // and any open editors reflect them.
  async function prepareNotes() {
    if (!data?.beat) return;
    setPreparingNotes(true);
    setPrepareError(null);
    try {
      await apiPostJson('/dialogs/direction', { beat_id: data.beat._id });
      onRefresh();
    } catch (e) {
      setPrepareError(e.message);
    } finally {
      setPreparingNotes(false);
    }
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const beatId = data?.beat?._id || null;

  function stopVoicePoll() {
    if (voicePollRef.current) clearInterval(voicePollRef.current);
    voicePollRef.current = null;
  }

  // Follow the beat's voice batch until it ends. Finished lines reach the
  // list through the room's pings; the last refresh catches the tail.
  const followVoiceJob = useCallback((id) => {
    stopVoicePoll();
    voicePollRef.current = setInterval(async () => {
      try {
        const r = await apiGet(`/dialogs/voices?beat_id=${encodeURIComponent(id)}`);
        setVoiceJob(r.job);
        if (r.job?.status !== 'running') {
          stopVoicePoll();
          onRefresh();
        }
      } catch {
        // Transient; the next tick retries.
      }
    }, 2000);
  }, [onRefresh]);

  // Reattach to a batch already running for this beat (reload, second tab).
  useEffect(() => {
    if (!beatId) return undefined;
    let cancelled = false;
    setVoiceJob(null);
    (async () => {
      try {
        const r = await apiGet(`/dialogs/voices?beat_id=${encodeURIComponent(beatId)}`);
        if (cancelled) return;
        setVoiceJob(r.job);
        if (r.job?.status === 'running') followVoiceJob(beatId);
      } catch {
        // The button still works; it reports its own errors.
      }
    })();
    return () => {
      cancelled = true;
      stopVoicePoll();
    };
  }, [beatId, followVoiceJob]);

  async function openVoiceDialog() {
    setVoiceError(null);
    try {
      const r = await apiGet(`/dialogs/voices?beat_id=${encodeURIComponent(beatId)}`);
      setVoicePreview(r.preview);
      setVoiceDialogOpen(true);
    } catch (e) {
      setVoiceError(e.message);
    }
  }

  async function generateVoices({ overwrite }) {
    setVoiceDialogOpen(false);
    setVoiceError(null);
    try {
      const r = await apiPostJson('/dialogs/voices/generate-all', { beat_id: beatId, overwrite });
      setVoiceJob(r.job);
      followVoiceJob(beatId);
    } catch (e) {
      setVoiceError(e.message);
    }
  }

  async function cancelVoices() {
    try {
      const r = await apiPostJson('/dialogs/voices/cancel', { beat_id: beatId });
      setVoiceJob(r.job);
    } catch (e) {
      setVoiceError(e.message);
    }
  }

  const voiceByCharacter = useMemo(() => {
    const map = new Map();
    for (const v of data?.voice_cast || []) map.set(String(v.character).toLowerCase(), v);
    return map;
  }, [data]);
  const voicesRunning = voiceJob?.status === 'running';

  useEffect(() => {
    if (!justAddedRef.current) return;
    justAddedRef.current = false;
    requestAnimationFrame(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth',
      });
    });
  }, [sortedItems.length]);

  const room = data?.beat?._id ? `dialogs:${data.beat._id}` : null;

  if (error) {
    return <div className="error-banner">{error}</div>;
  }
  if (!data) {
    return <p style={{ color: 'var(--fg-muted)' }}>Loading dialogue…</p>;
  }

  return (
    <>
      <div className="scenes-toolbar">
        <button
          className="primary"
          onClick={onGenerateClick}
          disabled={generating}
          title={
            sortedItems.length
              ? 'Replace existing dialog with a freshly extracted set'
              : "Auto-extract every spoken line from the beat body"
          }
        >
          {generating ? 'Generating…' : 'Generate'}
        </button>
        <button
          onClick={() => setEditOpen(true)}
          disabled={generating || sortedItems.length === 0}
          title="Open the LLM-driven edit dialog to add/move/delete/update items in batch"
        >
          Edit…
        </button>
        <button
          onClick={critique}
          disabled={generating || critiquing || sortedItems.length === 0}
          title="Score each line for naturalness and flag the weak ones"
        >
          {critiquing ? 'Critiquing…' : 'Critique'}
        </button>
        <button
          onClick={prepareNotes}
          disabled={generating || preparingNotes || sortedItems.length === 0}
          title="Generate a performance Direction note for every line in this beat"
        >
          {preparingNotes ? 'Preparing…' : 'Prepare notes'}
        </button>
        <button
          onClick={openVoiceDialog}
          disabled={generating || voicesRunning || sortedItems.length === 0}
          title="Generate every line's audio with its character's ElevenLabs voice (Eleven v4, audio tags)"
        >
          {voicesRunning ? 'Generating voices…' : '🎙 Generate all voices'}
        </button>
        <button
          onClick={() => setPerforming(true)}
          disabled={generating || sortedItems.length === 0}
          title="Open a distraction-free view to read context, see direction, and record each line"
        >
          ▶ Perform
        </button>
        <button onClick={addDialog} disabled={generating}>+ Add dialog</button>
        <button
          className="danger"
          onClick={() => setConfirmDeleteAll(true)}
          disabled={generating || sortedItems.length === 0}
          title="Delete every dialog item for this beat"
        >
          Delete all
        </button>
      </div>

      {generationError && (
        <div className="error-banner">Generation error: {generationError}</div>
      )}
      {deleteAllError && (
        <div className="error-banner">Delete failed: {deleteAllError}</div>
      )}
      {critiqueError && (
        <div className="error-banner">Critique failed: {critiqueError}</div>
      )}
      {prepareError && (
        <div className="error-banner">Prepare notes failed: {prepareError}</div>
      )}
      {voiceError && (
        <div className="error-banner">Voice generation: {voiceError}</div>
      )}
      {voiceJob && voiceJob.job_id !== dismissedVoiceJob && (
        <DialogVoicesBanner
          job={voiceJob}
          onCancel={cancelVoices}
          onDismiss={() => setDismissedVoiceJob(voiceJob.job_id)}
        />
      )}
      {generating && generationStatus && (
        <div
          style={{
            background: 'var(--accent-bg, rgba(255,255,255,0.04))',
            padding: '8px 12px',
            borderRadius: 4,
            marginBottom: 12,
          }}
        >
          {generationStatus.status === 'extracting' && 'Extracting dialog…'}
          {(generationStatus.status === 'queued' || !generationStatus.status) &&
            'Queued…'}
          {generationStatus.status === 'done' &&
            `Created ${generationStatus.created || 0} dialog ${(generationStatus.created || 0) === 1 ? 'line' : 'lines'}.`}
        </div>
      )}

      {room && (
        <CollabSurface room={room} session={session} active={active} onPing={onRefresh}>
          {performing ? (
            <DialogPerform
              items={sortedItems}
              onAudioChange={onRefresh}
              onClose={() => setPerforming(false)}
            />
          ) : (
          <>
          <div className="dialog-notes-panel" style={{ marginBottom: 16 }}>
            <CollabField
              label="Dialogue Notes"
              field="dialog_notes"
              multiline
              placeholder="Guidance for this beat's dialogue — tone, what's unsaid, who's lying… (fed into Generate, Regenerate, and Critique)"
            />
          </div>
          {sortedItems.length === 0 ? (
            <p style={{ color: 'var(--fg-muted)' }}>
              No dialog yet. Click <strong>Generate</strong> to auto-extract
              spoken lines from the beat body, or <strong>+ Add dialog</strong>{' '}
              for a blank entry.
            </p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={localOrder || []}
                strategy={verticalListSortingStrategy}
              >
                <div className="dialog-list">
                  {sortedItems.map((d, i) => {
                    const sid = d._id?.toString?.() || String(d._id);
                    const characterVoice = voiceByCharacter.get(plainSpeaker(d.character)) || null;
                    // A line's own voice outranks its character's.
                    const lineVoice = d.eleven_voice?.voice_id
                      ? { voice_id: d.eleven_voice.voice_id, voice_name: d.eleven_voice.name }
                      : null;
                    return (
                      <DialogItem
                        key={sid}
                        dialog={d}
                        characters={characters}
                        prevDialog={sortedItems[i - 1] || null}
                        nextDialog={sortedItems[i + 1] || null}
                        voice={lineVoice || characterVoice}
                        characterVoice={characterVoice}
                        voicesKnown={Array.isArray(data.voice_cast)}
                        onDelete={() => deleteDialog(d._id)}
                        onCharacterChange={setDialogCharacter}
                        onAudioChange={onRefresh}
                        onApplied={onRefresh}
                        critique={critiqueScores?.get(sid) || null}
                        isExpanded={expandedId === sid}
                        onExpandToggle={(toggledId) =>
                          setExpandedId((cur) => (cur === toggledId ? null : toggledId))
                        }
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
          </>
          )}
        </CollabSurface>
      )}

      <ConfirmDialog
        open={confirmGenerate}
        title="Replace existing dialog?"
        message={
          `This beat has ${sortedItems.length} dialog ${sortedItems.length === 1 ? 'item' : 'items'}. ` +
          `They will be deleted and replaced when generation produces new lines. ` +
          `If extraction returns no lines, your current items are preserved.`
        }
        confirmLabel="Generate"
        onConfirm={() => { setConfirmGenerate(false); generate(); }}
        onCancel={() => setConfirmGenerate(false)}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        title="Delete all dialog?"
        message={
          `This deletes all ${sortedItems.length} dialog ${sortedItems.length === 1 ? 'item' : 'items'} for this beat. ` +
          `This cannot be undone.`
        }
        confirmLabel="Delete all"
        danger
        onConfirm={() => { setConfirmDeleteAll(false); deleteAll(); }}
        onCancel={() => setConfirmDeleteAll(false)}
      />

      <GenerateVoicesDialog
        open={voiceDialogOpen}
        preview={voicePreview}
        onConfirm={generateVoices}
        onCancel={() => setVoiceDialogOpen(false)}
      />

      <DialogEditDialog
        open={editOpen}
        items={sortedItems}
        beatId={data?.beat?._id}
        onClose={() => setEditOpen(false)}
        onApplied={() => { setEditOpen(false); onRefresh(); }}
      />
    </>
  );
}

// A stored speaker name (markdown) as the plain lower-cased key the voice cast uses.
function plainSpeaker(name) {
  return String(name || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
