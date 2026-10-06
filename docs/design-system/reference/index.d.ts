import type * as React from 'react';

export type IconName = 'message-circle' | 'graduation-cap' | 'book-open' | 'layers' | 'target' | 'network' | 'pencil-line' | 'list-checks' | 'square-split-horizontal' | 'repeat' | 'file-pen' | 'lock' | 'paperclip' | 'image' | 'signature' | 'send' | 'square' | 'copy' | 'thumbs-up' | 'thumbs-down' | 'quote' | 'book-marked' | 'settings' | 'search' | 'plus' | 'arrow-left' | 'x' | 'chevron-right' | 'sigma' | 'code' | 'chart-line' | 'circle-alert' | 'check' | 'hard-drive' | 'cloud' | 'key-round' | 'terminal' | 'refresh-cw' | 'compass' | 'cpu' | 'flag' | 'clock' | 'circle-check' | 'circle-x' | 'upload';

/** The Pyxis mark (star trails), optionally with the wordmark. */
export interface LogoProps { size?: number; wordmark?: boolean; inverse?: boolean }
export declare function Logo(props: LogoProps): React.ReactElement;

/** Lucide line icon, 1.75 stroke, currentColor. */
export interface IconProps { name: IconName; size?: number; strokeWidth?: number; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

/** Pill button. One primary per view. */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg'; icon?: IconName; block?: boolean }
export declare function Button(props: ButtonProps): React.ReactElement;

/** Circular icon-only button; label is required. */
export interface IconButtonProps { icon: IconName; label: string; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; onClick?: () => void; disabled?: boolean }
export declare function IconButton(props: IconButtonProps): React.ReactElement;

export interface SegmentedItem { value: string; label: string; icon?: IconName; badge?: string }
/** Pill tabs with uppercase mono labels. */
export interface SegmentedTabsProps { items: SegmentedItem[]; value?: string; onChange?: (value: string) => void; label?: string }
export declare function SegmentedTabs(props: SegmentedTabsProps): React.ReactElement;

/** Pill single-line input. */
export interface TextFieldProps { placeholder?: string; value?: string; defaultValue?: string; onChange?: React.ChangeEventHandler<HTMLInputElement>; icon?: IconName; size?: 'md' | 'lg'; label?: string; type?: string }
export declare function TextField(props: TextFieldProps): React.ReactElement;

/** Suggested follow-up question. */
export interface ChipProps { children: React.ReactNode; icon?: IconName; onClick?: () => void }
export declare function Chip(props: ChipProps): React.ReactElement;

/** Origin / state label. */
export interface TagProps { tone?: 'neutral' | 'smartbook' | 'general' | 'mastered' | 'severe' | 'recommended'; icon?: IconName; children: React.ReactNode }
export declare function Tag(props: TagProps): React.ReactElement;

/** Inline source citation that opens the viewer. */
export interface CitationChipProps { kind?: 'smartbook' | 'pdf'; children: React.ReactNode; onClick?: () => void }
export declare function CitationChip(props: CitationChipProps): React.ReactElement;

/** Mastery meter with gold target tick. */
export interface MasteryBarProps { value: number; target?: number; tone?: 'mastery' | 'primary'; showValue?: boolean; label?: string }
export declare function MasteryBar(props: MasteryBarProps): React.ReactElement;

/** Study plan card for the home list. */
export interface PlanCardProps { subject?: string; title: string; mastery: number; target?: number; meta: string; cta?: string; onContinue?: () => void }
export declare function PlanCard(props: PlanCardProps): React.ReactElement;

/** Preparation summary tile. */
export interface StatTileProps { label: string; value: number; unit?: string; target?: number; pills?: string[]; stats?: { value: string; label: string }[] }
export declare function StatTile(props: StatTileProps): React.ReactElement;

/** Create-lesson choice tile. */
export interface LessonTileProps { icon: IconName; label: string; recommended?: boolean; count?: number; onClick?: () => void }
export declare function LessonTile(props: LessonTileProps): React.ReactElement;

/** Node on the vertical study path. */
export interface PathNodeProps { icon: IconName; label?: string; state?: 'done' | 'current' | 'available' | 'locked'; unlockHint?: string }
export declare function PathNode(props: PathNodeProps): React.ReactElement;

/** Knowledge gap row. */
export interface GapItemProps { severity?: 'severe' | 'minor'; topic: string; children: React.ReactNode; onFill?: () => void }
export declare function GapItem(props: GapItemProps): React.ReactElement;

/** Tutor chat input. No voice. */
export interface ComposerProps { subject?: string; sources?: string[]; mode?: 'solver' | 'socratic'; placeholder?: string; streaming?: boolean }
export declare function Composer(props: ComposerProps): React.ReactElement;

/** A chat turn. */
export interface ChatMessageProps { role?: 'user' | 'tutor'; children: React.ReactNode; engine?: string; suggestions?: string[]; general?: boolean }
export declare function ChatMessage(props: ChatMessageProps): React.ReactElement;

/** Quiz answer option. */
export interface QuizOptionProps { letter: string; children: React.ReactNode; state?: 'idle' | 'selected' | 'correct' | 'wrong'; onClick?: () => void }
export declare function QuizOption(props: QuizOptionProps): React.ReactElement;

/** Flashcard review with four ratings. */
export interface FlashcardProps { front: string; back: string; source?: string; flipped?: boolean; counters?: { nuove: number; apprendimento: number; padroneggiate: number } }
export declare function Flashcard(props: FlashcardProps): React.ReactElement;

/** Engine for AI row. */
export interface EngineRowProps { kind: 'cli' | 'api' | 'local' | 'remote'; name: string; model: string; status?: 'ok' | 'warn' | 'error' | 'idle'; statusText?: string; isDefault?: boolean }
export declare function EngineRow(props: EngineRowProps): React.ReactElement;

declare global { interface Window { Pyxis: { Logo: typeof Logo; Icon: typeof Icon; Button: typeof Button; IconButton: typeof IconButton; SegmentedTabs: typeof SegmentedTabs; TextField: typeof TextField; Chip: typeof Chip; Tag: typeof Tag; CitationChip: typeof CitationChip; MasteryBar: typeof MasteryBar; PlanCard: typeof PlanCard; StatTile: typeof StatTile; LessonTile: typeof LessonTile; PathNode: typeof PathNode; GapItem: typeof GapItem; Composer: typeof Composer; ChatMessage: typeof ChatMessage; QuizOption: typeof QuizOption; Flashcard: typeof Flashcard; EngineRow: typeof EngineRow } } }
