import { useEffect, useState } from 'react';
import { currentRoute, type Route } from './navigation';
import { LobbyPage } from './pages/LobbyPage';
import { AdminPage } from './pages/AdminPage';
import { JoinPage } from './pages/JoinPage';
import { RoomPage } from './pages/RoomPage';
import { ThemeProvider } from './theme';

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

  const page =
    route.kind === 'admin' ? (
      <AdminPage />
    ) : route.kind === 'join' ? (
      <JoinPage token={route.token} />
    ) : route.kind === 'room' ? (
      <RoomPage key={route.roomId} roomId={route.roomId} />
    ) : (
      <LobbyPage />
    );
  return <ThemeProvider>{page}</ThemeProvider>;
}

export default App;
