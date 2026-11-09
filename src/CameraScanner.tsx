import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, ImageUp, RefreshCw } from 'lucide-react';
import { scanSeconds, useScanCooldown } from './scan-cooldown';
import { cameraFrame } from '../lib/camera-frame';

function cameraError(error: unknown) {
  const name = (error as Error)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Permite el uso de la cámara en el navegador y vuelve a intentarlo.';
  if (name === 'NotFoundError') return 'No se encontró una cámara. Conecta una webcam o usa «Leer imagen QR».';
  if (name === 'NotReadableError' || name === 'AbortError')
    return 'No se pudo abrir la cámara. Cierra otras aplicaciones que puedan estar usándola y reintenta.';
  if (name === 'OverconstrainedError') return 'La cámara seleccionada no está disponible. Elige otra cámara.';
  return (error as Error)?.message || 'No se pudo iniciar la cámara.';
}

export default function CameraScanner({
  onScan,
  onClear,
  resetToken = '',
  autoStart = false,
  pauseWhenHidden = true,
  variant = 'default',
}: {
  onScan: (code: string) => Promise<void>;
  onClear: () => void;
  /** Changing this clears the last read code without tearing down the camera stream. */
  resetToken?: string;
  autoStart?: boolean;
  pauseWhenHidden?: boolean;
  variant?: 'default' | 'kiosk';
}) {
  const cameraAvailable = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
  const scanWait = useScanCooldown();
  const [enabled, setEnabled] = useState(autoStart),
    [device, setDevice] = useState(''),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [phase, setPhase] = useState('idle'),
    [error, setError] = useState(''),
    [retryCode, setRetryCode] = useState('');
  const [visible, setVisible] = useState(!document.hidden);
  const video = useRef<HTMLVideoElement>(null),
    callback = useRef(onScan),
    clear = useRef(onClear),
    processing = useRef(false),
    mounted = useRef(true),
    retry = useRef<(() => Promise<void>) | null>(null);
  // Read state lives in refs so the target (zone, movement) can change without restarting the stream.
  const lastCode = useRef(''),
    absentSince = useRef(0),
    failed = useRef(false);
  callback.current = onScan;
  clear.current = onClear;
  useEffect(() => {
    const visibility = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pageshow', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pageshow', visibility);
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    lastCode.current = '';
    absentSince.current = 0;
    failed.current = false;
    setRetryCode('');
    setError('');
    setPhase((current) => (current === 'idle' ? current : 'scanning'));
  }, [resetToken]);
  useEffect(() => {
    if (!enabled || (pauseWhenHidden && !visible)) return;
    let cancelled = false,
      stream: MediaStream | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement('canvas'),
      context = canvas.getContext('2d', { willReadFrequently: true })!;
    async function submit(value: string) {
      if (cancelled || processing.current) return;
      processing.current = true;
      setPhase('processing');
      setError('');
      clear.current();
      try {
        await callback.current(value);
        if (!cancelled) {
          failed.current = false;
          setRetryCode('');
          setPhase('waiting');
        }
      } catch (e) {
        if (!cancelled) {
          failed.current = true;
          setRetryCode(value);
          setError((e as Error).message);
          setPhase('error');
        }
      } finally {
        processing.current = false;
      }
    }
    async function start() {
      try {
        setError('');
        setRetryCode('');
        setPhase('starting');
        lastCode.current = '';
        absentSince.current = 0;
        failed.current = false;
        clear.current();
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
          throw Error(
            'Abre el enlace seguro del teléfono para activar la cámara. Pulsa «Conectar cámara del teléfono».',
          );
        const { default: decode } = await import('../vendor/jsqr/jsQR.js');
        if (cancelled) return;
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(device ? { deviceId: { exact: device } } : { facingMode: { ideal: 'environment' } }),
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const element = video.current!;
        element.srcObject = stream;
        await element.play();
        if (cancelled) return;
        setPhase('scanning');
        void navigator.mediaDevices
          .enumerateDevices()
          .then((list) => {
            if (!cancelled) setDevices(list.filter((d) => d.kind === 'videoinput'));
          })
          .catch(() => {});
        stream.getVideoTracks()[0].addEventListener('ended', () => {
          if (!cancelled && !document.hidden) {
            setError('La cámara se desconectó. Conéctala y vuelve a activarla.');
            setEnabled(false);
          }
        });
        async function tick() {
          if (cancelled) return;
          try {
            if (!processing.current && !failed.current && element.readyState >= 2 && element.videoWidth) {
              const bounds = element.getBoundingClientRect();
              const frame = cameraFrame(
                element.videoWidth,
                element.videoHeight,
                bounds.width,
                bounds.height,
                variant === 'kiosk',
              );
              if (!frame) return;
              canvas.width = frame.width;
              canvas.height = frame.height;
              context.drawImage(element, frame.sx, frame.sy, frame.sw, frame.sh, 0, 0, canvas.width, canvas.height);
              const pixels = context.getImageData(0, 0, canvas.width, canvas.height),
                found = decode(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' }),
                value = found?.data.trim();
              if (!value) {
                if (!absentSince.current) absentSince.current = Date.now();
                if (lastCode.current && Date.now() - absentSince.current > 1200) {
                  lastCode.current = '';
                  setPhase('scanning');
                }
              } else {
                absentSince.current = 0;
                if (value !== lastCode.current && scanSeconds() === 0) {
                  lastCode.current = value;
                  if (value.length > 200) {
                    setError('Este QR no es una credencial de acceso.');
                    setPhase('waiting');
                  } else {
                    retry.current = () => submit(value);
                    await submit(value);
                  }
                }
              }
            }
          } catch (e) {
            if (!cancelled) {
              setError('No se pudo leer la cámara. ' + cameraError(e));
              setEnabled(false);
            }
          } finally {
            if (!cancelled) timer = setTimeout(() => void tick(), 160);
          }
        }
        void tick();
      } catch (e) {
        if (!cancelled) {
          setError(cameraError(e));
          setEnabled(false);
          setPhase('idle');
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [enabled, device, pauseWhenHidden, visible, variant]);

  async function readImage(file: File) {
    if (processing.current || scanSeconds() > 0) return;
    setEnabled(false);
    setError('');
    setRetryCode('');
    clear.current();
    processing.current = true;
    setPhase('processing');
    let url = '';
    try {
      if (file.size > 15 * 1024 * 1024) throw Error('La imagen debe pesar menos de 15 MB.');
      const { default: decode } = await import('../vendor/jsqr/jsQR.js');
      url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas'),
        scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height),
        value = decode(pixels.data, pixels.width, pixels.height)?.data.trim();
      if (!mounted.current) return;
      if (!value) throw Error('No encontramos un QR legible. Usa una imagen nítida de la credencial completa.');
      if (value.length > 200) throw Error('Este QR no es una credencial de acceso.');
      retry.current = async () => {
        if (processing.current) return;
        processing.current = true;
        setError('');
        setPhase('processing');
        try {
          await callback.current(value);
          if (mounted.current) {
            setRetryCode('');
            setPhase('waiting');
          }
        } catch (e) {
          if (mounted.current) {
            setError((e as Error).message);
            setPhase('error');
          }
        } finally {
          processing.current = false;
        }
      };
      try {
        await callback.current(value);
      } catch (e) {
        if (mounted.current) setRetryCode(value);
        throw e;
      }
      if (mounted.current) setPhase('waiting');
    } catch (e) {
      if (mounted.current) {
        setError((e as Error).message);
        setPhase('error');
      }
    } finally {
      URL.revokeObjectURL(url);
      processing.current = false;
    }
  }
  const busy = phase === 'processing';
  return (
    <div className={`camera-scanner${variant === 'kiosk' ? ' kiosk-scanner' : ''}`} data-phase={phase}>
      <div className="camera-view" hidden={!enabled && variant !== 'kiosk'} aria-busy={phase === 'starting'}>
        <video ref={video} playsInline muted hidden={!enabled} aria-label="Vista de la cámara para escanear QR" />
        {variant === 'kiosk' && (!enabled || phase === 'starting') && (
          <div className="camera-empty">
            <Camera size={38} />
            <strong>
              {phase === 'starting'
                ? 'Permite usar la cámara'
                : cameraAvailable
                  ? 'Cámara en pausa'
                  : 'Abre el enlace seguro'}
            </strong>
            <p>
              {phase === 'starting'
                ? 'Acepta el permiso del navegador para empezar.'
                : cameraAvailable
                  ? 'Pulsa Activar cámara para leer credenciales.'
                  : 'Usa la conexión del teléfono para activar el lector.'}
            </p>
          </div>
        )}
        {enabled && (variant !== 'kiosk' || phase !== 'starting') && (
          <>
            <div className="camera-guide" aria-hidden="true" />
            <span className="camera-caption">
              {scanWait > 0
                ? `Próxima lectura en ${scanWait} s`
                : variant === 'kiosk'
                  ? 'Centra el QR en el recuadro'
                  : 'Coloca el QR completo dentro de la imagen'}
            </span>
          </>
        )}
      </div>
      <div className="camera-actions">
        <button
          type="button"
          className={'btn ' + (enabled ? 'secondary' : 'primary')}
          disabled={busy || !cameraAvailable}
          onClick={() => {
            setEnabled(!enabled);
            setError('');
            setRetryCode('');
            setPhase('idle');
          }}
        >
          {enabled ? <CameraOff size={18} /> : <Camera size={18} />} {enabled ? 'Apagar cámara' : 'Activar cámara'}
        </button>
        <label className={'btn secondary image-upload ' + (busy || scanWait > 0 ? 'disabled' : '')}>
          <ImageUp size={18} /> Leer imagen QR
          <input
            type="file"
            accept="image/*"
            aria-label="Leer imagen QR"
            disabled={busy || scanWait > 0}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void readImage(file);
            }}
          />
        </label>
      </div>
      {!cameraAvailable && (
        <div className="helper camera-network-note">
          <p>Abre la conexión segura de GymPASS para usar la cámara en iPhone o Android sin instalar certificados.</p>
          <a className="btn primary" href="/conectar">
            Conectar cámara del teléfono
          </a>
        </div>
      )}
      {enabled && devices.length > 1 && (
        <label className="camera-select">
          Cámara
          <select
            aria-label="Seleccionar cámara"
            value={device}
            disabled={busy}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">Automática (preferir trasera)</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Cámara ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="scanner-status" role="status">
        {phase === 'starting'
          ? 'Esperando permiso de cámara…'
          : busy
            ? 'Validando QR y registrando movimiento…'
            : scanWait > 0
              ? `Próxima lectura en ${scanWait} s. La espera entre escaneos es de cinco segundos.`
              : enabled && phase === 'waiting'
                ? 'Retira este QR para volver a leerlo, o presenta el de otra persona.'
                : enabled
                  ? 'Escaneo activo. El acceso se registra automáticamente.'
                  : cameraAvailable
                    ? 'Activa la cámara y presenta una credencial QR de GymPASS.'
                    : 'Abre el enlace seguro del teléfono para activar la cámara en vivo.'}
      </p>
      {error && (
        <div className="error-message" role="alert">
          {error}
          {retryCode && (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void retry.current?.()}>
              <RefreshCw size={16} /> Reintentar registro
            </button>
          )}
        </div>
      )}
    </div>
  );
}
