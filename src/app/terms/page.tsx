import type { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import { LegalContent } from '@/components/LegalContent';

export const metadata: Metadata = {
  title: 'Terms of Service - Flaxia',
  description: 'Terms of Service for Flaxia',
};

async function getContent(locale: string): Promise<string> {
  const filePath = path.join(process.cwd(), 'public', 'legal', `terms.${locale}.md`);
  const fallback = path.join(process.cwd(), 'public', 'legal', 'terms.en.md');
  try {
    return fs.readFileSync(fs.existsSync(filePath) ? filePath : fallback, 'utf-8');
  } catch {
    return 'Content not available.';
  }
}

export default async function TermsPage() {
  const content = await getContent('en');
  return <LegalContent type="terms" content={content} title="Terms of Service" effectiveDate="January 1, 2024" />;
}
