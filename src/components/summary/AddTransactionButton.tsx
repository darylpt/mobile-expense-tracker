'use client';

import { useState } from 'react';
import { Button } from '@/components/common/Button';
import { EditTransactionModal } from '@/components/forms/EditTransactionModal';

interface AddTransactionButtonProps {
  className?: string;
}

export function AddTransactionButton({ className }: AddTransactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setIsOpen(true)} className={className}>
        + Add
      </Button>
      {isOpen && (
        <EditTransactionModal
          transaction={null}
          mode="create"
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
