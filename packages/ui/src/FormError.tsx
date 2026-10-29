/** A form-wide problem, such as a refused sign-in, announced as soon as it shows. Renders nothing without a message. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="text-[13px] text-bad">
      {message}
    </p>
  )
}
