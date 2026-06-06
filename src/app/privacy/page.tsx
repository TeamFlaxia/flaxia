import type { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import { LegalContent } from '@/components/LegalContent';

export const metadata: Metadata = {
  title: 'Privacy Policy - Flaxia',
  description: 'Privacy Policy for Flaxia',
};

async function getContent(locale: string): Promise<string> {
  const filePath = path.join(process.cwd(), 'public', 'legal', `privacy.${locale}.md`);
  const fallback = path.join(process.cwd(), 'public', 'legal', 'privacy.en.md');
  try {
    return fs.readFileSync(fs.existsSync(filePath) ? filePath : fallback, 'utf-8');
  } catch {
    return 'Content not available.';
  }
}

export default async function PrivacyPage() {
  const content = await getContent('en');
  return <LegalContent type="privacy" content={content} title="Privacy Policy" effectiveDate="January 1, 2024" />;
}
