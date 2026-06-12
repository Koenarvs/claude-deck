import type { RouteObject } from 'react-router';
import App from './App';
import HomeRedirect from './components/HomeRedirect';
import KanbanPage from './pages/KanbanPage';
import DashboardPage from './pages/DashboardPage';
import GoalDetailPage from './pages/GoalDetailPage';
import SessionsListPage from './pages/SessionsListPage';
import SessionDetailPage from './pages/SessionDetailPage';
import AnalyticsPage from './pages/AnalyticsPage';
import ScheduledPage from './pages/ScheduledPage';
import SkillsPage from './pages/SkillsPage';
import ClaudeMdPage from './pages/ClaudeMdPage';
import SettingsPage from './pages/SettingsPage';
import OrchestratorPage from './pages/OrchestratorPage';

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'board', element: <KanbanPage /> },
      { path: 'orchestrator', element: <OrchestratorPage /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'goals/:id', element: <GoalDetailPage /> },
      { path: 'sessions', element: <SessionsListPage /> },
      { path: 'sessions/:id', element: <SessionDetailPage /> },
      { path: 'analytics', element: <AnalyticsPage /> },
      { path: 'scheduled', element: <ScheduledPage /> },
      { path: 'skills', element: <SkillsPage /> },
      { path: 'claude-md', element: <ClaudeMdPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
