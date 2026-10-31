import { useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';

type AuthInputFieldProps = {
  id: string;
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder: string;
  isDisabled: boolean;
  type?: 'text' | 'password' | 'email';
  name?: string;
  autoComplete?: string;
  icon?: ComponentType<{ className?: string }>;
};

/**
 * A labelled input field for authentication forms.
 * Used by the auth module's LoginForm and SetupForm for their credential inputs.
 * Renders a `<label>` / `<input>` pair and forwards browser autofill hints
 * (`name`, `autoComplete`) so that password managers can identify and fill
 * the field correctly. Password fields gain a show/hide visibility toggle.
 */
export default function AuthInputField({
  id,
  label,
  value,
  onChange,
  placeholder,
  isDisabled,
  type = 'text',
  name,
  autoComplete,
  icon: Icon,
}: AuthInputFieldProps) {
  const { t } = useTranslation('auth');
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);

  const isPasswordField = type === 'password';
  const resolvedType = isPasswordField && isPasswordVisible ? 'text' : type;

  return (
    <div>
      <label htmlFor={id} className="kb-m mb-2 block text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </label>
      <div className="group relative">
        {Icon && (
          <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
        )}
        <input
          id={id}
          type={resolvedType}
          name={name ?? id}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`h-12 w-full rounded-[5px] border border-input bg-background py-2.5 text-[15px] text-foreground transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/60 hover:border-foreground/20 focus:border-primary/65 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60 ${
            Icon ? 'pl-10' : 'pl-3.5'
          } ${isPasswordField ? 'pr-[54px]' : 'pr-3.5'}`}
          placeholder={placeholder}
          required
          disabled={isDisabled}
        />
        {isPasswordField && (
          <button
            type="button"
            onClick={() => setIsPasswordVisible((previous) => !previous)}
            disabled={isDisabled}
            aria-label={isPasswordVisible ? t('misc.hide') : t('misc.show')}
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:text-orange-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
          >
            {isPasswordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
