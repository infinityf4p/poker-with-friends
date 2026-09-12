import type { SVGProps } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  Copy,
  Crown,
  Eye,
  EyeOff,
  History,
  KeyRound,
  Layers2,
  LockKeyhole,
  LogIn,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Spade,
  Sparkles,
  Table2,
  TriangleAlert,
  UserRound,
  UsersRound,
  Wifi,
  X,
} from 'lucide-react';

const icons = {
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  book: BookOpen,
  cards: Layers2,
  check: Check,
  chevron: ChevronRight,
  chip: CircleDot,
  clock: Clock3,
  close: X,
  copy: Copy,
  crown: Crown,
  door: LogIn,
  eye: Eye,
  'eye-off': EyeOff,
  history: History,
  key: KeyRound,
  lock: LockKeyhole,
  logout: LogOut,
  pause: Pause,
  play: Play,
  plus: Plus,
  refresh: RefreshCw,
  settings: SlidersHorizontal,
  shield: ShieldCheck,
  spade: Spade,
  spark: Sparkles,
  table: Table2,
  user: UserRound,
  users: UsersRound,
  warning: TriangleAlert,
  wifi: Wifi,
};

export type IconName = keyof typeof icons;

export function Icon({
  name,
  size = 20,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const LucideIcon = icons[name];
  return <LucideIcon size={size} strokeWidth={1.7} aria-hidden="true" {...props} />;
}
