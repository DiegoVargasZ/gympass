import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const apk = resolve(process.argv[2] || '');
const serial = process.argv[3];
const expectedInterface = process.argv[4] || 'any';
if (!process.argv[2] || !/^emulator-\d+$/.test(serial || '') || !['any', 'web', 'reader', 'management'].includes(expectedInterface))
  throw Error('Uso: node scripts/check-android-start.mjs ruta/al/APK emulator-5554 [web|reader|management]. Solo se prueba en emuladores.');
const executable = process.env.ADB_BINARY || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe') : 'adb');
const adb = (args, encoding = 'utf8') => execFileSync(executable, ['-s', serial, ...args], { encoding, timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const packageName = 'local.gympass.controlacceso.mobile';
const directory = resolve('output/android-crash');
mkdirSync(directory, { recursive: true });
const logPath = join(directory, basename(apk) + '-startup.log');
const starts = [];
try {
  adb(['install', '-r', apk]);
  adb(['logcat', '-c']);
  for (let attempt = 0; attempt < 2; attempt++) {
    adb(['shell', 'am', 'force-stop', packageName]);
    const launch = adb(['shell', 'am', 'start', '-W', '-n', packageName + '/.MainActivity']);
    if (!/Status: ok/.test(launch)) throw Error('Android no pudo abrir la actividad.');
    let ready = false;
    for (let check = 0; check < 10; check++) {
      await delay(1500);
      let pid;
      try { pid = adb(['shell', 'pidof', packageName]).trim(); } catch { throw Error('GymPASS se cerró durante el arranque. Consulta ' + logPath); }
      if (!pid) throw Error('GymPASS terminó durante el arranque.');
      adb(['shell', 'uiautomator', 'dump', '/sdcard/gympass-smoke.xml']);
      const ui = adb(['shell', 'cat', '/sdcard/gympass-smoke.xml']);
      const webLogin = ui.includes('android.webkit.WebView') && ui.includes('Iniciar sesión') && ui.includes('Correo electrónico') && ui.includes('Gestión');
      const readerLogin = ui.includes('Te damos la bienvenida') && ui.includes('Dirección HTTPS de GymPASS');
      const readerReady = ui.includes('Recepción') && ui.includes('Lector sin conexión') && (ui.includes('Centra el QR en el recuadro') || ui.includes('Coloca el QR completo dentro de la imagen')) && !ui.includes('Iniciar sesión');
      const managementReady = ui.includes('android.webkit.WebView') && ui.includes('Sincronización automática') && (ui.includes('Hoy en tu gimnasio') || ui.includes('Socios'));
      if ((expectedInterface === 'management' && managementReady) || (expectedInterface === 'any' && managementReady) || (expectedInterface === 'reader' && readerReady) || (!['reader', 'management'].includes(expectedInterface) && (webLogin || (expectedInterface !== 'web' && readerLogin)))) {
        starts.push({ attempt: attempt + 1, pid, login_visible: !readerReady && !managementReady, interface: managementReady ? 'management-local' : readerReady ? 'reader-session' : webLogin ? 'web' : 'reader' });
        ready = true;
        break;
      }
    }
    if (!ready) throw Error('El proceso sigue activo pero no llegó al login.');
    await delay(3000);
    adb(['shell', 'pidof', packageName]);
  }
  const logs = adb(['logcat', '-d', '-v', 'threadtime']);
  writeFileSync(logPath, logs);
  if (/Cannot find native module|Failed to materialize module|E ReactNativeJS.*(?:Error|Exception)|JavascriptException/.test(logs))
    throw Error('Android registró un error de ejecución. Consulta ' + logPath);
  writeFileSync(join(directory, basename(apk) + '-screen.png'), adb(['exec-out', 'screencap', '-p'], null));
  const proof = { apk: basename(apk), sha256: createHash('sha256').update(readFileSync(apk)).digest('hex'), checked_at: new Date().toISOString(), emulator: serial, android: adb(['shell', 'getprop', 'ro.build.version.release']).trim(), page_size: Number(adb(['shell', 'getconf', 'PAGE_SIZE']).trim()), starts, passed: true };
  writeFileSync(join(directory, basename(apk) + '-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
} catch (error) {
  writeFileSync(logPath, adb(['logcat', '-d', '-v', 'threadtime']));
  throw error;
}
