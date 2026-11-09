import type { ReactNode } from 'react';
export default function PageHeader({
  title,
  description,
  primaryAction,
  children,
}: {
  title: string;
  description?: string;
  primaryAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {children}
      </div>
      {primaryAction && <div className="heading-actions">{primaryAction}</div>}
    </div>
  );
}
