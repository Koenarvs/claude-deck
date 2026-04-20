import { useEffect, useState } from 'react';
import { useGoalsStore } from '../stores/useGoalsStore';
import { useApprovalsStore } from '../stores/useApprovalsStore';
import { useSessionsStore } from '../stores/useSessionsStore';
import { useFeedStore } from '../stores/useFeedStore';
import StatCards from '../components/dashboard/StatCards';
import ActiveGoalsStrip from '../components/dashboard/ActiveGoalsStrip';
import RecentActivityFeed from '../components/dashboard/RecentActivityFeed';
import GoalProgress from '../components/dashboard/GoalProgress';
import QuickActions from '../components/dashboard/QuickActions';
import type { Goal, Session, HookEvent, GoalStatus } from '../shared/types';

/** Fetch initial data for all dashboard sections in parallel. */
async function fetchInitialData(): Promise<{
  goals: Goal[];
  sessions: Session[];
  events: HookEvent[];
}> {
  const [goalsRes, sessionsRes, eventsRes] = await Promise.all([
    fetch('/api/goals'),
    fetch('/api/sessions?active=true'),
    fetch('/api/hook-events?limit=20'),
  ]);

  const [goals, sessions, events] = await Promise.all([
    goalsRes.ok ? (goalsRes.json() as Promise<Goal[]>) : Promise.resolve([]),
    sessionsRes.ok ? (sessionsRes.json() as Promise<Session[]>) : Promise.resolve([]),
    eventsRes.ok ? (eventsRes.json() as Promise<HookEvent[]>) : Promise.resolve([]),
  ]);

  return { goals, sessions, events };
}

export default function DashboardPage() {
  const goals = useGoalsStore((s) => s.goals);
  const setGoals = useGoalsStore((s) => s.setGoals);
  const pendingApprovals = useApprovalsStore((s) => s.pending);
  const sessions = useSessionsStore((s) => s.sessions);
  const setSessions = useSessionsStore((s) => s.setSessions);
  const feedEvents = useFeedStore((s) => s.events);
  const setEvents = useFeedStore((s) => s.setEvents);

  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetchInitialData()
      .then((data) => {
        if (cancelled) return;
        setGoals(data.goals);
        setSessions(data.sessions);
        // Seed feed store only if it was empty (don't overwrite WS-received events)
        if (feedEvents.length === 0 && data.events.length > 0) {
          setEvents(data.events);
        }
      })
      .catch(() => {
        // Server may not be running; stores stay at defaults
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derived stats (live via WS-updated stores)
  const activeGoals = goals.filter((g) => g.status === 'active');
  const activeSessions = sessions.filter((s) => s.ended_at === null);
  const completedGoals = goals.filter((g) => g.status === 'complete');

  const statusCounts: Record<GoalStatus, number> = {
    planning: goals.filter((g) => g.status === 'planning').length,
    active: activeGoals.length,
    waiting: goals.filter((g) => g.status === 'waiting').length,
    complete: completedGoals.length,
    archived: goals.filter((g) => g.status === 'archived').length,
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-deck-muted">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-deck-text">Dashboard</h1>
        <QuickActions />
      </div>

      <StatCards
        activeGoals={activeGoals.length}
        activeSessions={activeSessions.length}
        pendingApprovals={pendingApprovals.length}
        totalCompleted={completedGoals.length}
      />

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-deck-muted">Active Goals</h2>
        <ActiveGoalsStrip goals={activeGoals} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <GoalProgress statusCounts={statusCounts} />
        <RecentActivityFeed events={feedEvents} />
      </div>
    </div>
  );
}
