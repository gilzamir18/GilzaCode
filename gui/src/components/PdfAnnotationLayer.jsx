import React from 'react';
import { MessageSquare } from 'lucide-react';

/**
 * Draws the annotations that the rendered PDF canvas is not painting yet.
 *
 * Annotations live inside the PDF file, so pdf.js paints them from their
 * appearance streams as part of the page — this overlay must not draw those a
 * second time or every mark would show up doubled and darker. It therefore draws
 * only what the loaded bytes do not contain: marks created since the document was
 * fetched. Once the document is reloaded they become part of the canvas and drop
 * out of here.
 *
 * The layer never takes pointer events. Text selection is how annotations get
 * created in the first place, so anything that intercepted the mouse over the page
 * would break the feature it exists to serve; hit-testing for the context menu is
 * done geometrically against the same normalized rects instead.
 *
 * Rects are normalized 0..1 against the page box, which is what the backend
 * stores, so this layer needs no zoom factor: percentages scale themselves.
 */

const asPercent = (value) => `${value * 100}%`;

function markStyle(annotation, rect) {
  const [x0, y0, x1, y1] = rect;
  const base = {
    position: 'absolute',
    left: asPercent(x0),
    top: asPercent(y0),
    width: asPercent(Math.max(0, x1 - x0)),
    height: asPercent(Math.max(0, y1 - y0)),
    pointerEvents: 'none',
  };

  switch (annotation.kind) {
    case 'highlight':
      // Multiply keeps the glyphs readable through the wash of color, which is
      // how a real highlighter behaves and how the PDF appearance stream renders.
      return { ...base, background: annotation.color, opacity: 0.4, mixBlendMode: 'multiply' };
    case 'underline':
      return { ...base, borderBottom: `2px solid ${annotation.color}` };
    case 'strikeout':
      return {
        ...base,
        background: 'transparent',
        borderTop: `2px solid ${annotation.color}`,
        // A strikeout sits on the text's middle, not its top edge.
        transform: 'translateY(-50%)',
        top: asPercent((y0 + y1) / 2),
        height: 0,
      };
    case 'squiggly':
      return {
        ...base,
        borderBottom: `2px dotted ${annotation.color}`,
      };
    default:
      return base;
  }
}

/**
 * Where a note marker sits, as a [x, y] centre in 0..1 page coordinates.
 *
 * A marker the user has dragged carries its own position (`annotation.marker`,
 * stored in the PDF); otherwise it is derived from the mark's geometry.
 */
function markerPosition(annotation) {
  if (Array.isArray(annotation.marker) && annotation.marker.length >= 2) {
    return { point: annotation.marker, placed: true };
  }
  const rect = (annotation.rects || [])[0];
  if (!rect) return null;
  const [, y0, x1, y1] = rect;
  return { point: [x1, (y0 + y1) / 2], placed: false };
}

// Below this much travel a press is a click, not a drag. Without it, the tremor
// of an ordinary click would register as a move and shift the marker a pixel.
const DRAG_THRESHOLD_PX = 4;

export default function PdfAnnotationLayer({ annotations, pendingIds, onOpenNote, onMoveNote }) {
  const rootRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const [drag, setDrag] = React.useState(null);

  const handleMarkerPointerDown = (annotation) => (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id: annotation.id,
      annotation,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  };

  const handleMarkerPointerMove = (event) => {
    const state = dragRef.current;
    const root = rootRef.current;
    if (!state || !root) return;
    const travel = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    if (!state.moved && travel < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    const box = root.getBoundingClientRect();
    setDrag({
      id: state.id,
      point: [
        Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)),
      ],
    });
  };

  const handleMarkerPointerUp = (event) => {
    const state = dragRef.current;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!state) return;
    if (!state.moved) {
      // A press that never travelled is a click: open the note.
      if (onOpenNote) onOpenNote(state.annotation, event);
      setDrag(null);
      return;
    }
    const dropped = drag && drag.id === state.id ? drag.point : null;
    setDrag(null);
    if (dropped && onMoveNote) onMoveNote(state.annotation, dropped);
  };

  if (!annotations || annotations.length === 0) return null;

  const drawable = annotations.filter((a) => pendingIds.has(a.id));
  // A mark carrying a note looks exactly like one that does not, so without a
  // visible indicator the note is unreachable — you would have to hover every
  // highlight in the document to find out which ones have something attached.
  const annotated = annotations.filter((a) => (a.content || '').trim().length > 0);

  if (drawable.length === 0 && annotated.length === 0) return null;

  return (
    <div
      ref={rootRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    >
      {drawable.map((annotation) => {
        if (annotation.kind === 'note') {
          // A note carrying text gets the clickable marker below instead; drawing
          // both would put two icons on the same spot.
          if ((annotation.content || '').trim()) return null;
          const [x0, y0] = annotation.rects[0] || [0, 0];
          return (
            <div
              key={annotation.id}
              title={annotation.content || ''}
              style={{
                position: 'absolute',
                left: asPercent(x0),
                top: asPercent(y0),
                width: 14,
                height: 14,
                borderRadius: 3,
                background: annotation.color,
                border: '1px solid rgba(0,0,0,0.35)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                pointerEvents: 'none',
              }}
            />
          );
        }
        return (
          <React.Fragment key={annotation.id}>
            {(annotation.rects || []).map((rect, index) => (
              <div key={index} style={markStyle(annotation, rect)} />
            ))}
          </React.Fragment>
        );
      })}

      {/* Note markers. These are the one part of the layer that takes pointer
          events, and they are deliberately tiny and parked just past the end of
          the mark, so they never sit between the cursor and the text the user is
          trying to select. */}
      {annotated.map((annotation) => {
        const anchor = markerPosition(annotation);
        if (!anchor) return null;
        const dragging = drag && drag.id === annotation.id;
        const [left, top] = dragging ? drag.point : anchor.point;
        // A marker that has been placed is centred on its point; a derived one
        // hangs just past the end of the mark's first line so it does not cover
        // the text it belongs to.
        const centred = dragging || anchor.placed;
        return (
          <button
            key={`note_${annotation.id}`}
            type="button"
            className={`pdf-annotation-note-marker${centred ? ' pdf-annotation-note-marker-placed' : ''}${dragging ? ' pdf-annotation-note-marker-dragging' : ''}`}
            style={{ left: asPercent(left), top: asPercent(top), borderColor: annotation.color }}
            title={annotation.content}
            aria-label={annotation.content}
            onPointerDown={handleMarkerPointerDown(annotation)}
            onPointerMove={handleMarkerPointerMove}
            onPointerUp={handleMarkerPointerUp}
            onPointerCancel={() => { dragRef.current = null; setDrag(null); }}
            // The press is handled on pointerup so a drag and a click can be told
            // apart; suppressing the click keeps it from firing a second time.
            onClick={(event) => event.preventDefault()}
          >
            {/* A lucide glyph rather than an emoji: it matches the app's icon
                language and takes the marker's color, where an emoji renders in
                its own palette and differs across platforms. */}
            <MessageSquare size={9} strokeWidth={2.5} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
