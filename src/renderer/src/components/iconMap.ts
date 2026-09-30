import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  ChartLine,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Quote,
  Clock,
  Cloud,
  Code,
  Compass,
  Copy,
  Cpu,
  FilePen,
  Flag,
  GraduationCap,
  HardDrive,
  Image,
  KeyRound,
  Layers,
  ListChecks,
  Lock,
  MessageCircle,
  Network,
  Paperclip,
  PencilLine,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Send,
  Settings,
  Sigma,
  Signature,
  Square,
  SquareSplitHorizontal,
  Target,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Upload,
  X,
} from "lucide-react";

export type IconName =
  | "message-circle"
  | "graduation-cap"
  | "book-open"
  | "layers"
  | "target"
  | "network"
  | "pencil-line"
  | "list-checks"
  | "square-split-horizontal"
  | "repeat"
  | "file-pen"
  | "lock"
  | "paperclip"
  | "image"
  | "signature"
  | "send"
  | "square"
  | "copy"
  | "thumbs-up"
  | "thumbs-down"
  | "quote"
  | "book-marked"
  | "settings"
  | "search"
  | "plus"
  | "arrow-left"
  | "x"
  | "chevron-right"
  | "sigma"
  | "code"
  | "chart-line"
  | "circle-alert"
  | "check"
  | "hard-drive"
  | "cloud"
  | "key-round"
  | "terminal"
  | "refresh-cw"
  | "compass"
  | "cpu"
  | "flag"
  | "clock"
  | "circle-check"
  | "circle-x"
  | "upload"
  | "loader-circle"
  | "circle";

export const ICON_MAP: Record<IconName, LucideIcon> = {
  "message-circle": MessageCircle,
  "graduation-cap": GraduationCap,
  "book-open": BookOpen,
  layers: Layers,
  target: Target,
  network: Network,
  "pencil-line": PencilLine,
  "list-checks": ListChecks,
  "square-split-horizontal": SquareSplitHorizontal,
  repeat: Repeat,
  "file-pen": FilePen,
  lock: Lock,
  paperclip: Paperclip,
  image: Image,
  signature: Signature,
  send: Send,
  square: Square,
  copy: Copy,
  "thumbs-up": ThumbsUp,
  "thumbs-down": ThumbsDown,
  quote: Quote,
  "book-marked": BookMarked,
  settings: Settings,
  search: Search,
  plus: Plus,
  "arrow-left": ArrowLeft,
  x: X,
  "chevron-right": ChevronRight,
  sigma: Sigma,
  code: Code,
  "chart-line": ChartLine,
  "circle-alert": CircleAlert,
  check: Check,
  "hard-drive": HardDrive,
  cloud: Cloud,
  "key-round": KeyRound,
  terminal: Terminal,
  "refresh-cw": RefreshCw,
  compass: Compass,
  cpu: Cpu,
  flag: Flag,
  clock: Clock,
  "circle-check": CircleCheck,
  "circle-x": CircleX,
  upload: Upload,
  "loader-circle": LoaderCircle,
  circle: Circle,
};
