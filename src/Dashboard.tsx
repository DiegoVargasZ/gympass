import { CheckCircle2, ScanLine, Users } from 'lucide-react';
import type { Bootstrap } from '../lib/domain';
import { EventTable, PageHeader } from './ui';
import GymPresence from './GymPresence';

export default function Dashboard({ data }: { data: Bootstrap }) {
  const capacityAlerts = data.zones.filter(
    (zone) => zone.active && zone.capacity > 0 && zone.inside >= zone.capacity * 0.9,
  );
  return (
    <>
      <PageHeader
        title="Hoy en tu gimnasio"
        description="Mira quién está entrenando ahora y registra cuando alguien llega o se va."
        primaryAction={
          data.user.role !== 'viewer' && (
            <a className="btn primary" href="#access">
              <ScanLine size={18} />
              Registrar entrada o salida
            </a>
          )
        }
      />
      {data.user.role === 'admin' && data.stats.activePeople === 0 && (
        <section className="panel" aria-labelledby="first-steps">
          <div className="panel-heading">
            <div>
              <h2 id="first-steps">Empieza en 4 pasos</h2>
              <p>Cuando termines, aquí verás quién está entrenando.</p>
            </div>
          </div>
          <ol className="priority-list">
            {[
              ['Registra a tu primer socio', 'Nombre y datos básicos.', '#people?new', 'Registrar socio'],
              ['Crea y cobra su plan', 'En Caja, crea un plan y confirma el cobro. El acceso empieza en la fecha de inicio del plan pagado.', '#pos', 'Abrir Caja'],
              ['Entrégale su credencial QR', 'El primer cobro crea su QR permanente. Puedes descargarlo o compartirlo.', '#credentials', 'Ver credenciales'],
              ['Registra su entrada', 'Muestra el QR en la cámara.', '#access', 'Registrar entrada'],
            ].map(([title, text, href, action]) => (
              <li key={title}>
                <CheckCircle2 size={21} aria-hidden="true" />
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
                <a className="btn secondary small" href={href}>
                  {action}
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div className="dashboard-layout">
        <div className="dashboard-main">
          {!!capacityAlerts.length && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Ocupación de las zonas</h2>
              </div>
              <ul className="priority-list">
                {capacityAlerts.map((zone) => (
                  <li key={zone.id}>
                    <Users size={21} />
                    <div>
                      <strong>
                        {zone.name}: {zone.inside >= zone.capacity ? 'aforo completo' : 'cerca del aforo'}
                      </strong>
                      <p>
                        {zone.inside} de {zone.capacity} personas dentro
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <GymPresence data={data} />
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Últimas entradas y salidas</h2>
                <p>Lo más reciente que pasó en el gimnasio.</p>
              </div>
              {data.user.role !== 'operator' && (
                <a className="text-link" href="#history">
                  Ver todo el historial
                </a>
              )}
            </div>
            <EventTable events={data.events} timezone={data.settings.timezone} />
          </section>
        </div>
        <aside className="today-summary" aria-label="Resumen de hoy">
          <h2>Resumen de hoy</h2>
          <dl>
            {[
              ['Llegadas', data.stats.entries],
              ['Salidas', data.stats.exits],
              ['Entradas rechazadas', data.stats.denied],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{new Intl.NumberFormat('es-BO').format(Number(value))}</dd>
              </div>
            ))}
          </dl>
          {data.user.role !== 'operator' && (
            <a className="text-link" href="#history">
              Ver el motivo de cada rechazo
            </a>
          )}
        </aside>
      </div>
    </>
  );
}
