import { useEffect, useRef, useState } from 'react';
import { Field } from './ui';

export default function PhotoEditor({ onChange }: { onChange: (photo: Blob | null | undefined) => void }) {
  const [source, setSource] = useState(''),
    [crop, setCrop] = useState({ zoom: 1, x: 50, y: 50 }),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [dragging, setDragging] = useState(false),
    [cameraOpen, setCameraOpen] = useState(false),
    [cameraPending, setCameraPending] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    generation = useRef(0),
    video = useRef<HTMLVideoElement>(null),
    cameraStream = useRef<MediaStream | null>(null),
    cameraGeneration = useRef(0),
    loadedImage = useRef<{ source: string; image: HTMLImageElement } | null>(null),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    cropRef = useRef(crop);
  const { zoom, x, y } = crop;
  const updateCrop = (next: typeof crop) => {
    cropRef.current = next;
    setCrop(next);
  };
  const transform = (scale: number, from: { x: number; y: number }, to = from) => {
    const image = loadedImage.current?.source === source ? loadedImage.current.image : null;
    const bounds = canvas.current?.getBoundingClientRect();
    if (!image || !bounds?.width || !bounds.height) return;
    const current = cropRef.current;
    const nextZoom = Math.max(1, Math.min(3, current.zoom * scale));
    const size = Math.min(image.width, image.height) / current.zoom;
    const nextSize = Math.min(image.width, image.height) / nextZoom;
    const position = (dimension: number, value: number, before: number, after: number, length: number) => {
      const origin = ((dimension - size) * value) / 100 + (before / length) * size - (after / length) * nextSize;
      return dimension > nextSize ? Math.max(0, Math.min(100, (100 * origin) / (dimension - nextSize))) : 50;
    };
    updateCrop({
      zoom: nextZoom,
      x: position(image.width, current.x, from.x - bounds.left, to.x - bounds.left, bounds.width),
      y: position(image.height, current.y, from.y - bounds.top, to.y - bounds.top, bounds.height),
    });
  };
  useEffect(() => {
    pointers.current.clear();
    setDragging(false);
  }, [source]);
  useEffect(() => {
    const preview = canvas.current;
    if (!preview || !source) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? preview.clientHeight : 1);
      transform(Math.exp(-Math.max(-150, Math.min(150, delta)) * 0.003), { x: event.clientX, y: event.clientY });
    };
    preview.addEventListener('wheel', wheel, { passive: false });
    return () => preview.removeEventListener('wheel', wheel);
  }, [source]);
  const stopCamera = () => {
    cameraGeneration.current++;
    cameraStream.current?.getTracks().forEach((track) => track.stop());
    cameraStream.current = null;
    setCameraOpen(false);
    setCameraPending(false);
  };
  const openCamera = async () => {
    const version = ++cameraGeneration.current;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw Error('La cámara requiere una conexión segura (HTTPS o localhost).');
      setError('');
      setCameraPending(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      if (version !== cameraGeneration.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      cameraStream.current = stream;
      setCameraOpen(true);
      setCameraPending(false);
    } catch (cause) {
      if (version !== cameraGeneration.current) return;
      setCameraPending(false);
      const failure = cause as Error;
      setError(
        failure?.name === 'NotAllowedError'
          ? 'Permiso de cámara denegado. Actívalo en la configuración del navegador.'
          : failure?.name === 'NotFoundError'
            ? 'No se encontró ninguna cámara.'
            : failure?.message || 'No se pudo abrir la cámara.',
      );
    }
  };
  const capturePhoto = () => {
    const preview = video.current;
    if (!preview?.videoWidth || !preview.videoHeight) return;
    const snapshot = document.createElement('canvas'),
      version = cameraGeneration.current;
    snapshot.width = preview.videoWidth;
    snapshot.height = preview.videoHeight;
    const context = snapshot.getContext('2d');
    if (!context) {
      setError('No se pudo tomar la foto.');
      return;
    }
    context.drawImage(preview, 0, 0);
    snapshot.toBlob(
      (blob) => {
        if (version !== cameraGeneration.current) return;
        if (!blob) {
          setError('No se pudo tomar la foto.');
          return;
        }
        setSource(URL.createObjectURL(blob));
        updateCrop({ zoom: 1, x: 50, y: 50 });
        setError('');
        stopCamera();
      },
      'image/jpeg',
      0.92,
    );
  };
  useEffect(
    () => () => {
      cameraGeneration.current++;
      cameraStream.current?.getTracks().forEach((track) => track.stop());
      cameraStream.current = null;
    },
    [],
  );
  useEffect(() => {
    if (cameraOpen && video.current && cameraStream.current) {
      video.current.srcObject = cameraStream.current;
      video.current.play().catch(() => {});
    }
  }, [cameraOpen]);
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source],
  );
  useEffect(() => {
    if (!source) return;
    const version = ++generation.current,
      image = loadedImage.current?.source === source ? loadedImage.current.image : new Image();
    let live = true;
    onChange(undefined);
    setReady(false);
    const renderCrop = () => {
      if (!live) return;
      loadedImage.current = { source, image };
      const target = canvas.current,
        context = target?.getContext('2d');
      if (!target || !context) return;
      const size = Math.min(image.width, image.height) / zoom;
      context.clearRect(0, 0, 512, 512);
      context.drawImage(
        image,
        ((image.width - size) * x) / 100,
        ((image.height - size) * y) / 100,
        size,
        size,
        0,
        0,
        512,
        512,
      );
      target.toBlob(
        (blob) => {
          if (!live || version !== generation.current) return;
          if (!blob || blob.type !== 'image/webp')
            setError('Este navegador no puede guardar WebP. Prueba con un navegador actualizado.');
          else {
            onChange(blob);
            setReady(true);
            setError('');
          }
        },
        'image/webp',
        0.88,
      );
    };
    image.onerror = () => {
      if (live) setError('No pudimos leer esta imagen.');
    };
    if (loadedImage.current?.source === source) renderCrop();
    else {
      image.onload = renderCrop;
      image.src = source;
    }
    return () => {
      live = false;
    };
  }, [source, zoom, x, y, onChange]);
  return (
    <div className="photo-editor">
      <Field
        label="Foto de la persona"
        hint="Elige un archivo PNG, JPEG o WebP o usa la cámara. Ajusta el encuadre; se guardará una copia cuadrada de 512 px."
      >
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
              setError('Selecciona una imagen PNG, JPEG o WebP de hasta 10 MB.');
              event.target.value = '';
              return;
            }
            stopCamera();
            setSource(URL.createObjectURL(file));
            updateCrop({ zoom: 1, x: 50, y: 50 });
            setError('');
          }}
        />
      </Field>
      <div className="photo-camera" style={{ margin: '0 0 12px' }}>
        {!cameraOpen && !cameraPending && (
          <button type="button" className="btn secondary" onClick={() => void openCamera()}>
            Tomar foto con la cámara
          </button>
        )}
        {(cameraOpen || cameraPending) && (
          <div>
            {cameraPending && (
              <p role="status" className="helper">
                Abriendo cámara…
              </p>
            )}
            {cameraOpen && (
              <video
                ref={video}
                autoPlay
                playsInline
                muted
                aria-label="Vista de la cámara"
                style={{
                  display: 'block',
                  width: '100%',
                  maxWidth: 360,
                  borderRadius: 8,
                  background: '#000',
                  transform: 'scaleX(-1)',
                }}
              />
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {cameraOpen && (
                <button type="button" className="btn" onClick={capturePhoto}>
                  Capturar foto
                </button>
              )}
              <button type="button" className="btn secondary" onClick={stopCamera}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
      {source && (
        <div className="photo-crop">
          <div>
            <canvas
              ref={canvas}
              width={512}
              height={512}
              aria-label="Vista previa del recorte de la foto"
              aria-describedby="photo-crop-help"
              tabIndex={0}
              data-dragging={dragging || undefined}
              onKeyDown={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
                if (event.key === '+' || event.key === '=') transform(1.1, center);
                else if (event.key === '-') transform(1 / 1.1, center);
                else if (event.key.startsWith('Arrow')) {
                  const offset = event.shiftKey ? 24 : 8;
                  transform(1, center, {
                    x: center.x + (event.key === 'ArrowLeft' ? -offset : event.key === 'ArrowRight' ? offset : 0),
                    y: center.y + (event.key === 'ArrowUp' ? -offset : event.key === 'ArrowDown' ? offset : 0),
                  });
                } else return;
                event.preventDefault();
              }}
              onPointerDown={(event) => {
                if ((event.pointerType !== 'touch' && event.button !== 0) || pointers.current.size >= 2) return;
                if (loadedImage.current?.source !== source) return;
                event.preventDefault();
                pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                event.currentTarget.focus({ preventScroll: true });
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(true);
              }}
              onPointerMove={(event) => {
                const previous = pointers.current.get(event.pointerId);
                if (!previous) return;
                const next = { x: event.clientX, y: event.clientY };
                const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
                if (other) {
                  const distance = Math.hypot(previous.x - other.x, previous.y - other.y);
                  transform(
                    distance > 0 ? Math.hypot(next.x - other.x, next.y - other.y) / distance : 1,
                    { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 },
                    { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 },
                  );
                } else transform(1, previous, next);
                pointers.current.set(event.pointerId, next);
              }}
              onPointerUp={(event) => {
                pointers.current.delete(event.pointerId);
                setDragging(pointers.current.size > 0);
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                pointers.current.delete(event.pointerId);
                setDragging(pointers.current.size > 0);
              }}
              onLostPointerCapture={(event) => {
                pointers.current.delete(event.pointerId);
                setDragging(pointers.current.size > 0);
              }}
            />
            <p className="helper" id="photo-crop-help">
              Arrastra para mover la foto. Acerca o aleja con la rueda del ratón o con dos dedos.
              <span className="sr-only"> Con el teclado, usa las flechas para mover y las teclas + y − para acercar o alejar.</span>
            </p>
          </div>
          <div>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                setSource('');
                onChange(null);
              }}
            >
              Descartar foto seleccionada
            </button>
          </div>
        </div>
      )}
      {source && !error && (
        <p role="status" className="helper">
          {ready ? 'Foto preparada · 512 × 512 px' : 'Preparando foto…'}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </div>
  );
}
