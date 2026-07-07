package memory_test

import (
	"testing"

	"mythinkingpal/server/internal/storage"
	"mythinkingpal/server/internal/storage/memory"
	"mythinkingpal/server/internal/storage/storagetest"
)

func TestMemoryStoreContract(t *testing.T) {
	storagetest.RunAccountStoreContract(t, func(t *testing.T) storage.AccountStore {
		return memory.New()
	})
}
