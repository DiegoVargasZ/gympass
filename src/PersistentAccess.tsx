import { useEffect, useState } from 'react';
import Access from './Access';
import type { Bootstrap } from '../lib/domain';

/** Keep the reader and its camera alive while navigating within this session. */
export default function PersistentAccess({ active, data, reload }: {
  active: boolean;
  data: Bootstrap;
  reload: () => Promise<void>;
}) {
  const [opened, setOpened] = useState(active);
  useEffect(() => {
    if (active) setOpened(true);
  }, [active]);
  if (!active && !opened) return null;
  return <div hidden={!active}><Access data={data} reload={reload} active={active} /></div>;
}
