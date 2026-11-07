import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input } from "antd";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { CrashReportsSwitch } from "../../components/CrashReportsSwitch";
import { Notice } from "../../components/Notice";
import { Stepper } from "../../components/Stepper";
import { PROFILE_LIMITS } from "@shared/limits";
import { invoke } from "../../lib/ipc";
import { useMenuLock } from "../../app/menu-state";
import { PyxisMark } from "../../app/layouts/Sidebar";
import { EnginesStep, type EnginesState } from "./EnginesStep";
import { MaterialStep } from "./MaterialStep";
import {
  firstAnswers,
  savedProfile,
  schoolLevels,
  studiesOf,
  type Level,
  type StoredProfile,
} from "./setup";
import "./OnboardingPage.css";
import { profileQuery } from "../../lib/queries";

/**
 * First setup is three steps: you, the AI, the material. The profile is saved when the AI step ends, so "Later" on the
 * material step lands the student on Chiedi with the profile kept. The material step links the student's folders and
 * names their subjects; it draws its own three screens. Exams are made later, from Esami. A rerun has the first two
 * steps.
 */
const firstSteps = ["profile", "engines", "material"] as const;
const rerunSteps = ["profile", "engines"] as const;
type StepId = (typeof firstSteps)[number];

/**
 * First setup, or with `?again=1` (Settings > Profile > Run setup again) the profile and AI steps for a student who
 * already has a profile. A rerun waits for the stored profile so the screens open filled in.
 */
export function OnboardingPage() {
  const [params] = useSearchParams();
  const again = params.get("again") === "1";
  const profile = useQuery({ ...profileQuery, enabled: again });
  if (again && profile.isPending) return null;
  // A rerun link without a profile is a first setup.
  return <Setup stored={again ? (profile.data ?? null) : null} />;
}

function Setup({ stored }: { stored: StoredProfile | null }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Setup is not left through the menu: Shell sends a profile-less student back here, and a rerun has its own Cancel.
  useMenuLock(true);
  const again = stored !== null;
  const steps: readonly StepId[] = again ? rerunSteps : firstSteps;
  const [index, setIndex] = useState(0);
  const [start] = useState(() => firstAnswers(stored));
  const [name, setName] = useState(start.name);
  const [level, setLevel] = useState<Level>(start.level);
  const [year, setYear] = useState(start.year);
  const [school, setSchool] = useState(start.school);
  const [course, setCourse] = useState(start.course);
  // Off for a new install, so nothing is sent unless the student turns it on. A rerun shows the stored choice.
  const [crashReports, setCrashReports] = useState(start.crashReports);
  // Unknown until the engines are read, so the button says Continue rather than flicker to "later".
  const [engines, setEngines] = useState<EnginesState>({
    ready: null,
    notice: false,
    picking: false,
    connected: [],
  });
  const onEngines = useCallback((state: EnginesState) => setEngines(state), []);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = steps[index]!;

  // A new screen starts at its top and its heading, so keyboard and screen reader users do not land in the old controls
  // and the page does not open at the previous screen's scroll offset.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    heading.current?.focus({ preventScroll: true });
  }, [index]);

  /** Saves the profile. Skip saves an empty one and leaves setup. Resolves with whether it saved. */
  async function save(skip: boolean): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setFailed(false);
    try {
      await invoke(
        "profile.save",
        skip
          ? { displayName: "" }
          : savedProfile(
              { name, level, year, school, course, crashReports },
              t("onboarding.contentLanguage"),
              stored,
            ),
      );
      await client.invalidateQueries({ queryKey: ["profile"] });
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  // A rerun ends where it started.
  const backToSettings = () => navigate("/settings/profile", { replace: true });
  const next = () => setIndex((value) => Math.min(value + 1, steps.length - 1));
  const back = () => setIndex((value) => Math.max(value - 1, 0));

  // Every screen ends in the same footer: one way back or out on the left, the way forward on the right.
  const backButton = (
    <Button shape="round" disabled={busy} onClick={back}>
      {t("nav.back")}
    </Button>
  );
  let secondary: ReactNode = null;
  let primary: ReactNode = null;
  let title = t(`onboarding.${id}.title`);
  let body = t(`onboarding.${id}.body`);
  if (id === "profile") {
    secondary = again ? (
      <Button shape="round" onClick={backToSettings}>
        {t("wizard.cancel")}
      </Button>
    ) : (
      <Button
        shape="round"
        disabled={busy}
        onClick={() =>
          void save(true).then((saved) => {
            if (saved) navigate("/ask");
          })
        }
      >
        {t("onboarding.skip")}
      </Button>
    );
    primary = (
      <Button type="primary" shape="round" size="large" onClick={next}>
        {t("onboarding.continue")}
      </Button>
    );
  } else if (id === "engines") {
    if (engines.connected.length) {
      title = t("onboarding.ai.readyTitle", {
        names: new Intl.ListFormat(
          i18n.language.startsWith("it") ? "it" : "en-GB",
          { style: "long", type: "conjunction" },
        ).format(engines.connected),
        count: engines.connected.length,
      });
      body = t("onboarding.ai.readyBody");
    } else {
      title = t("onboarding.ai.title");
      body = t("onboarding.ai.body");
    }
    secondary = backButton;
    // One primary action per state: the notice's "I understand", a card's install or sign-in, or this button.
    const quiet = engines.notice || (engines.picking && !engines.ready);
    primary = (
      <Button
        type={quiet ? "default" : "primary"}
        shape="round"
        size={quiet ? "middle" : "large"}
        loading={busy}
        onClick={() =>
          void save(false).then((saved) => {
            if (!saved) return;
            if (again) backToSettings();
            else next();
          })
        }
      >
        {t(
          again
            ? "onboarding.again.done"
            : engines.ready === false
              ? "onboarding.later"
              : "onboarding.continue",
        )}
      </Button>
    );
  }

  return (
    <div
      className={
        id === "profile" ? "px-onboarding" : "px-onboarding is-wide"
      }
    >
      <div className="px-onboarding-head">
        <span className="px-brand">
          <PyxisMark />
          Pyxis
        </span>
        <Stepper
          numbered
          steps={steps.map((item) => t(`onboarding.steps.${item}`))}
          current={index}
        />
      </div>
      {/* The material step draws its own title and footer: each of its screens has its own. */}
      {id === "material" ? (
        <MaterialStep heading={heading} onBack={back} onLeave={() => navigate("/ask")} />
      ) : (
        <div className="px-onboarding-title">
          <h1 className="display" tabIndex={-1} ref={heading}>
            {title}
          </h1>
          <p className="body">{body}</p>
        </div>
      )}

      {id === "profile" ? (
        <>
          <ProfileStep
            values={{ name, level, year, school, course }}
            set={{ setName, setLevel, setYear, setSchool, setCourse }}
          />
          <CrashReportsSwitch
            setup
            checked={crashReports}
            disabled={busy}
            onChange={setCrashReports}
          />
        </>
      ) : null}
      {id === "engines" ? (
        <EnginesStep onState={onEngines} again={again} />
      ) : null}

      {failed ? (
        <Notice tone="danger">{t("onboarding.saveFailed")}</Notice>
      ) : null}
      {id === "material" ? null : (
        <div className="px-onboarding-actions">
          <span>{secondary}</span>
          <span className="px-onboarding-primary">{primary}</span>
        </div>
      )}
    </div>
  );
}

function ProfileStep(props: {
  values: {
    name: string;
    level: Level;
    year: string;
    school: string;
    course: string;
  };
  set: {
    setName: (value: string) => void;
    setLevel: (value: Level) => void;
    setYear: (value: string) => void;
    setSchool: (value: string) => void;
    setCourse: (value: string) => void;
  };
}) {
  const { t } = useTranslation();
  const { values, set } = props;
  const studies = studiesOf(values.level);
  // Back to school after a look at university keeps the school picked before; a new profile starts at upper secondary.
  const [lastSchool, setLastSchool] = useState<Level>(
    studies === "school" ? values.level : "upper-secondary",
  );
  const optional = (
    <span className="px-onboarding-optional"> {t("onboarding.optional")}</span>
  );
  const field = (
    id: string,
    label: ReactNode,
    value: string,
    onChange: (value: string) => void,
    max: number,
  ) => (
    <div className="px-form-field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        maxLength={max}
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
  return (
    <div className="px-card px-onboarding-card">
      <div className="px-onboarding-grid">
        {field(
          "profile-name",
          t("onboarding.name"),
          values.name,
          set.setName,
          PROFILE_LIMITS.displayName,
        )}
        <div className="px-form-field">
          <span className="label" id="profile-studies">
            {t("onboarding.studies.label")}
          </span>
          <div
            className="px-onboarding-seg"
            role="radiogroup"
            aria-labelledby="profile-studies"
          >
            {(["university", "school"] as const).map((item) => (
              <SegButton
                key={item}
                checked={studies === item}
                onSelect={() => {
                  if (item === studies) return;
                  set.setLevel(item === "university" ? "university" : lastSchool);
                }}
              >
                {t(`onboarding.studies.${item}`)}
              </SegButton>
            ))}
          </div>
        </div>
        {studies === "university" ? (
          <div className="px-onboarding-more px-grow" key="university">
            {field(
              "profile-course",
              t("onboarding.studies.degree"),
              values.course,
              set.setCourse,
              PROFILE_LIMITS.course,
            )}
            {field(
              "profile-school",
              <>
                {t("onboarding.studies.universityName")}
                {optional}
              </>,
              values.school,
              set.setSchool,
              PROFILE_LIMITS.school,
            )}
            {field(
              "profile-year",
              <>
                {t("onboarding.year")}
                {optional}
              </>,
              values.year,
              set.setYear,
              PROFILE_LIMITS.year,
            )}
          </div>
        ) : (
          <div className="px-onboarding-more px-grow" key="school">
            <div className="px-form-field px-onboarding-wide">
              <span className="label" id="profile-level">
                {t("onboarding.studies.which")}
              </span>
              <div
                className="px-onboarding-levels"
                role="radiogroup"
                aria-labelledby="profile-level"
              >
                {schoolLevels.map((item) => (
                  <SegButton
                    key={item}
                    chip
                    checked={item === values.level}
                    onSelect={() => {
                      setLastSchool(item);
                      set.setLevel(item);
                    }}
                  >
                    {t(`onboarding.levels.${item}`)}
                  </SegButton>
                ))}
              </div>
            </div>
            {field(
              "profile-school",
              <>
                {t("onboarding.studies.schoolName")}
                {optional}
              </>,
              values.school,
              set.setSchool,
              PROFILE_LIMITS.school,
            )}
            {field(
              "profile-year",
              t("onboarding.year"),
              values.year,
              set.setYear,
              PROFILE_LIMITS.year,
            )}
            {field(
              "profile-course",
              <>
                {t("onboarding.studies.track")}
                {optional}
              </>,
              values.course,
              set.setCourse,
              PROFILE_LIMITS.course,
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One option of a radio group drawn as buttons. Arrow keys move the choice, as in any radio group, and only the chosen
 * option is in the tab order.
 */
function SegButton({
  checked,
  chip = false,
  onSelect,
  children,
}: {
  checked: boolean;
  chip?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className={chip ? "px-onboarding-chip" : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const group = event.currentTarget.parentElement;
        const options = Array.from(
          group?.querySelectorAll<HTMLButtonElement>("[role=radio]") ?? [],
        );
        const at = options.indexOf(event.currentTarget);
        const step = keys.indexOf(event.key) < 2 ? 1 : -1;
        const target = options[(at + step + options.length) % options.length];
        target?.focus();
        target?.click();
      }}
    >
      {children}
    </button>
  );
}
