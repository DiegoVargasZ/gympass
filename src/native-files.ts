declare global {
  interface Window {
    __gympassSaveBlob?: (blob: Blob, name: string) => Promise<void>;
    __gympassCopyImage?: (blob: Blob) => Promise<void>;
    __gympassShareCredential?: (file: File, text: string, phone: string) => Promise<void>;
    gympassDesktop?: { copyImage: (base64: string) => Promise<void> };
  }
}

export async function copyCredentialImage(file: Blob) {
  if (window.__gympassCopyImage) return window.__gympassCopyImage(file);
  if (window.gympassDesktop) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(Error('No se pudo leer la credencial.'));
      reader.readAsDataURL(file);
    });
    return window.gympassDesktop.copyImage(data);
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw Error('Este navegador no permite copiar imágenes. Usa Compartir o Descargar PNG.');
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': file })]);
}
