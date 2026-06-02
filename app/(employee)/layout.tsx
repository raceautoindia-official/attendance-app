import EmployeeLayout from '@/components/layout/EmployeeLayout';

export default function EmployeeGroupLayout({ children }: { children: React.ReactNode }) {
  return <EmployeeLayout>{children}</EmployeeLayout>;
}
