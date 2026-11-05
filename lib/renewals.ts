export function remainingDays(expires: string, today: string) {
  return Math.round((Date.parse(expires + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400000);
}
export function renewalMessage(name: string, organization: string, expires: string, days: number) {
  const time =
    days < 0
      ? 'Tu acceso ha vencido'
      : days === 0
        ? 'Tu acceso vence hoy'
        : days === 1
          ? 'Te queda 1 día de acceso'
          : `Te quedan ${days} días de acceso`;
  return `Hola ${name}. ${time} en ${organization}. Fecha de vencimiento: ${expires}. Por favor, acércate a recepción para renovar. ¡Gracias!`;
}
