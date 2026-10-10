import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../content/ops';
import { call } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useOrg } from '../org/OrgProvider';

/** Bell with unread count; opening the panel marks everything shown as read. */
export function NotificationBell() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { orgId } = useOrg();
  const notifications = useNotifications(orgId);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const uid = user?.uid ?? '';
  const unread = notifications.data.filter((n) => !n.readBy.includes(uid));

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread.length) {
      void call('markNotificationsRead', { orgId, notificationIds: unread.map((n) => n.id) }).catch(() => undefined);
    }
  }

  return (
    <div className="bell" ref={panel}>
      <button
        type="button"
        className="shell__icon-btn"
        aria-label={t('notifications.label', { count: unread.length })}
        aria-expanded={open}
        onClick={toggle}
      >
        <Bell size={18} />
        {unread.length ? <span className="bell__badge">{unread.length > 9 ? '9+' : unread.length}</span> : null}
      </button>
      {open ? (
        <div className="bell__panel" role="dialog" aria-label={t('shell.notifications')}>
          <div className="bell__head">{t('shell.notifications')}</div>
          {notifications.data.length === 0 ? (
            <p className="vx-muted bell__empty">{t('notifications.empty')}</p>
          ) : (
            <ul className="bell__list">
              {notifications.data.map((n) => {
                const text = t(`notifications.types.${n.type}`, n.params);
                const unreadNow = unread.some((u) => u.id === n.id);
                return (
                  <li key={n.id} className={`bell__item bell__item--${n.type}${unreadNow ? ' bell__item--unread' : ''}`}>
                    {n.link ? (
                      <Link to={n.link} onClick={() => setOpen(false)}>
                        {text}
                      </Link>
                    ) : (
                      <span>{text}</span>
                    )}
                    <span className="vx-muted">{formatDateTime(n.createdAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
