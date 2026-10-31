import { TriangleAlert } from 'lucide-react';

type AuthErrorAlertProps = {
  errorMessage: string;
};

/** Rendered by the auth module's LoginForm and SetupForm to surface submit and session errors. */
export default function AuthErrorAlert({ errorMessage }: AuthErrorAlertProps) {
  if (!errorMessage) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-[5px] border border-primary/50 bg-primary/10 px-3.5 py-3"
    >
      <TriangleAlert className="mt-px h-[18px] w-[18px] flex-shrink-0 text-orange-400" strokeWidth={1.8} />
      <p className="text-sm font-medium leading-normal text-foreground">{errorMessage}</p>
    </div>
  );
}
