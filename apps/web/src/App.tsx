import { useEffect, useState } from 'react';
import { currentRoute, type Route } from './navigation';
import { LobbyPage } from './pages/LobbyPage';
import { AdminPage } from './pages/AdminPage';
import { JoinPage } from './pages/JoinPage';
import { RoomPage } from './pages/RoomPage';

function App() {
  const [route, setRoute] = useState<Route>(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  useEffect(() => {
    const pageTitle =
      route.kind === 'admin'
        ? '管理后台'
        : route.kind === 'join'
          ? '加入牌桌'
          : route.kind === 'room'
            ? '牌桌'
            : '牌桌大厅';
    document.title = `${pageTitle} · Poker with Friends`;
  }, [route]);

  if (route.kind === 'admin') return <AdminPage />;
  if (route.kind === 'join') return <JoinPage token={route.token} />;
  if (route.kind === 'room') return <RoomPage key={route.roomId} roomId={route.roomId} />;
  return <LobbyPage />;
}

export default App;
