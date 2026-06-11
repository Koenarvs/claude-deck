import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MarkdownView from '../../../src/components/shared/MarkdownView';

const CONTENT = '# Hello\n\nWorld para';

afterEach(() => vi.restoreAllMocks());

describe('MarkdownView', () => {
  it('defaults to pretty (md) — renders a heading, not the raw "#"', () => {
    render(<MarkdownView content={CONTENT} />);
    expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument();
    expect(screen.queryByText(/# Hello/)).toBeNull();
  });

  it('toggles md ↔ txt to show raw source', () => {
    render(<MarkdownView content={CONTENT} />);
    fireEvent.click(screen.getByRole('button', { name: 'txt' }));
    // Raw markdown is now visible verbatim.
    expect(screen.getByText(/# Hello/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull();
  });

  it('is read-only (no Edit button) when onSave is omitted', () => {
    render(<MarkdownView content={CONTENT} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('Edit opens a textarea seeded with the raw source', () => {
    render(<MarkdownView content={CONTENT} onSave={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const ta = screen.getByLabelText('Edit content') as HTMLTextAreaElement;
    expect(ta.value).toBe(CONTENT);
  });

  it('Save calls onSave with the edited content then exits edit mode', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<MarkdownView content={CONTENT} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit content'), { target: { value: '# Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('# Changed'));
    // Back to read mode.
    await waitFor(() => expect(screen.queryByLabelText('Edit content')).toBeNull());
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('Save failure keeps the buffer and shows an inline error', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('Disk full'));
    render(<MarkdownView content={CONTENT} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit content'), { target: { value: '# Keep me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disk full');
    // Still editing, buffer preserved.
    expect((screen.getByLabelText('Edit content') as HTMLTextAreaElement).value).toBe('# Keep me');
  });

  it('Cancel with unsaved changes asks for confirmation', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MarkdownView content={CONTENT} onSave={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit content'), { target: { value: 'dirty' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).toHaveBeenCalled();
    // Confirmed → back to read mode.
    expect(screen.queryByLabelText('Edit content')).toBeNull();
  });

  it('Cancel with NO changes does not prompt', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MarkdownView content={CONTENT} onSave={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Edit content')).toBeNull();
  });
});
