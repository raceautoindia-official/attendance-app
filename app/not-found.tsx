import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center space-y-6">
        <div>
          <p className="text-8xl font-black text-slate-200 dark:text-slate-800 select-none">404</p>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 -mt-4">
            Page not found
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-2 text-sm">
            The page you are looking for does not exist or has been moved.
          </p>
        </div>

        <Link
          href="/login"
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
          Back to home
        </Link>
      </div>
    </div>
  );
}
