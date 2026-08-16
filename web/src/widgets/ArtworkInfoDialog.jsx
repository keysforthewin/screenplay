import { Modal } from './Modal.jsx';
import { imageUrl, thumbUrl } from '../api.js';

// "How was this image made?" panel for one artwork. Shows the exact
// parameters that produced the current result: the model the user picked, the
// endpoint the provider actually routed to, the reference images sent, and
// the verbatim prompt. Artworks rendered before generation recording existed
// fall back to the artwork's own prompt/model/reference fields, flagged as
// the *requested* setup rather than a record of what was sent.
export function ArtworkInfoDialog({ open, onClose, artwork }) {
  if (!artwork) return null;
  const gen = artwork.generation || null;
  const requestedModel = gen?.requested_model || artwork.model || '(unknown)';
  const endpoint = gen?.endpoint || null;
  const refIds = (gen?.reference_image_ids ?? artwork.reference_image_ids ?? []).map(String);
  const sentCount = gen && Number.isFinite(gen.reference_sent_count)
    ? gen.reference_sent_count
    : null;
  const prompt = gen?.prompt ?? artwork.prompt ?? '';
  const completedAt = gen?.completed_at || artwork.updated_at || null;

  return (
    <Modal open={open} title="Generation info" onClose={onClose} size="wide">
      <div className="artwork-info">
        {!gen && (
          <p className="artwork-info-legacy">
            This artwork predates generation recording — the values below are
            what was <em>requested</em>, not a record of the exact provider call.
          </p>
        )}

        <div className="artwork-info-row">
          <span className="field-label">Model</span>
          <div className="artwork-info-value">
            <code>{requestedModel}</code>
            {endpoint && endpoint !== requestedModel && (
              <span className="artwork-info-endpoint">
                {' '}— ran as <code>{endpoint}</code>
              </span>
            )}
          </div>
        </div>

        {gen?.mode === 'edit' && (
          <div className="artwork-info-row">
            <span className="field-label">Mode</span>
            <div className="artwork-info-value">
              In-line edit of the previous result
              {gen.existing_image_id ? (
                <>
                  {' '}(
                  <a href={imageUrl(gen.existing_image_id)} target="_blank" rel="noreferrer">
                    base image
                  </a>
                  )
                </>
              ) : null}
            </div>
          </div>
        )}

        <div className="artwork-info-row">
          <span className="field-label">
            Reference images
            {refIds.length > 0 && sentCount != null && sentCount !== refIds.length
              ? ` (${refIds.length} assigned, ${sentCount} sent to the model)`
              : refIds.length > 0 && sentCount != null
                ? ` (${sentCount} sent to the model)`
                : ''}
          </span>
          {refIds.length === 0 ? (
            <div className="artwork-info-value artwork-info-norefs">
              None — generated from the prompt alone.
            </div>
          ) : (
            <div className="frame-generate-ref-grid">
              {refIds.map((id) => (
                <div className="frame-generate-ref-thumb" key={id}>
                  <img
                    src={thumbUrl(id)}
                    alt="reference"
                    loading="lazy"
                    onClick={() => window.open(imageUrl(id), '_blank', 'noopener')}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="artwork-info-row">
          <span className="field-label">Prompt</span>
          {prompt ? (
            <pre className="artwork-info-prompt">{prompt}</pre>
          ) : (
            <div className="artwork-info-value">(no prompt on file)</div>
          )}
        </div>

        {completedAt && (
          <div className="artwork-info-row">
            <span className="field-label">Generated</span>
            <div className="artwork-info-value">
              {new Date(completedAt).toLocaleString()}
            </div>
          </div>
        )}

        {artwork.status === 'error' && artwork.error_message && (
          <div className="artwork-info-row">
            <span className="field-label">Error</span>
            <div className="artwork-info-value artwork-card-error">{artwork.error_message}</div>
          </div>
        )}
      </div>
    </Modal>
  );
}
