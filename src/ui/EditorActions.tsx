import type { ReactNode } from 'react';
export type EditorState = 'saved' | 'dirty' | 'saving' | 'error';
export default function EditorActions({
  state,
  onSave,
  onDiscard,
  secondaryAction,
}: {
  state: EditorState;
  onSave: () => void;
  onDiscard?: () => void;
  secondaryAction?: ReactNode;
}) {
  return (
    <div className="editor-actions">
      <span role="status">
        {
          {
            saved: 'Guardado',
            dirty: 'Cambios sin guardar',
            saving: 'Guardando…',
            error: 'No se guardaron los cambios',
          }[state]
        }
      </span>
      <div className="button-row">
        {onDiscard && state !== 'saved' && (
          <button className="btn secondary" disabled={state === 'saving'} onClick={onDiscard}>
            Descartar cambios
          </button>
        )}
        <button className="btn primary" disabled={state === 'saved' || state === 'saving'} onClick={onSave}>
          {state === 'saving' ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {secondaryAction}
      </div>
    </div>
  );
}
