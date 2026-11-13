import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookMarked,
  BookOpen,
  CalendarPlus,
  ChartLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleQuestionMark,
  Circle,
  CircleDashed,
  CircleDot,
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
  FilePlus,
  Flag,
  GraduationCap,
  HardDrive,
  Image,
  Info,
  KeyRound,
  Layers,
  ListChecks,
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
  TrendingDown,
  TrendingUp,
  X,
  Ellipsis,
  Link,
  Trash2,
  Palette,
  Scan,
  Undo2,
  Redo2,
  Download,
  ExternalLink,
  Lock,
  Pencil,
  Archive,
  ArrowRight,
  Diamond,
  RotateCcw,
  SlidersHorizontal,
  Star,
  Contrast,
  Lightbulb,
  ListOrdered,
} from "lucide-react";

export type IconName =
  | "message-circle"
  | "graduation-cap"
  | "book-open"
  | "calendar-plus"
  | "layers"
  | "target"
  | "network"
  | "pencil-line"
  | "lightbulb"
  | "list-ordered"
  | "list-checks"
  | "square-split-horizontal"
  | "repeat"
  | "file-pen"
  | "file-plus"
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
  | "chevron-left"
  | "chevron-right"
  | "circle-question-mark"
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
  | "loader-circle"
  | "circle"
  | "circle-dashed"
  | "circle-dot"
  | "chevron-down"
  | "info"
  | "trending-up"
  | "trending-down"
  | "ellipsis"
  | "link"
  | "trash-2"
  | "palette"
  | "scan"
  | "undo-2"
  | "redo-2"
  | "download"
  | "external-link"
  | "lock"
  | "pencil"
  | "archive"
  | "arrow-right"
  | "diamond"
  | "rotate-ccw"
  | "sliders-horizontal"
  | "star"
  | "contrast";

export const ICON_MAP: Record<IconName, LucideIcon> = {
  "message-circle": MessageCircle,
  "graduation-cap": GraduationCap,
  "book-open": BookOpen,
  "calendar-plus": CalendarPlus,
  layers: Layers,
  target: Target,
  network: Network,
  "pencil-line": PencilLine,
  lightbulb: Lightbulb,
  "list-ordered": ListOrdered,
  "list-checks": ListChecks,
  "square-split-horizontal": SquareSplitHorizontal,
  repeat: Repeat,
  "file-pen": FilePen,
  "file-plus": FilePlus,
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
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  "circle-question-mark": CircleQuestionMark,
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
  "loader-circle": LoaderCircle,
  circle: Circle,
  "circle-dashed": CircleDashed,
  "circle-dot": CircleDot,
  "chevron-down": ChevronDown,
  info: Info,
  "trending-up": TrendingUp,
  "trending-down": TrendingDown,
  ellipsis: Ellipsis,
  link: Link,
  "trash-2": Trash2,
  palette: Palette,
  scan: Scan,
  "undo-2": Undo2,
  "redo-2": Redo2,
  download: Download,
  "external-link": ExternalLink,
  lock: Lock,
  pencil: Pencil,
  archive: Archive,
  "arrow-right": ArrowRight,
  diamond: Diamond,
  "rotate-ccw": RotateCcw,
  "sliders-horizontal": SlidersHorizontal,
  star: Star,
  contrast: Contrast,
};
