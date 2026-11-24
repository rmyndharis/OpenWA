package openwa

import (
	"math"
	"testing"
	"time"
)

func TestRetryPolicyBackoffOverflowAndClamp(t *testing.T) {
	t.Run("large attempt with zero MaxDelay does not overflow negative", func(t *testing.T) {
		p := RetryPolicy{BaseDelay: 200 * time.Millisecond, MaxDelay: 0}
		for _, attempt := range []int{0, 10, 62, 63, 64, 1000} {
			d := p.backoff(attempt)
			if d <= 0 {
				t.Fatalf("attempt %d produced non-positive delay %v", attempt, d)
			}
		}
	})

	t.Run("huge BaseDelay and attempt clamp to MaxDelay without overflow", func(t *testing.T) {
		p := RetryPolicy{
			BaseDelay: time.Duration(math.MaxInt64 / 3),
			MaxDelay:  5 * time.Second,
		}
		for _, attempt := range []int{0, 1, 5, 100} {
			d := p.backoff(attempt)
			if d < 2500*time.Millisecond || d > 5*time.Second {
				t.Fatalf("attempt %d out of clamped jitter bounds [2.5s, 5s]: %v", attempt, d)
			}
		}
	})

	t.Run("jitter stays bounded in [d/2, d] and spreads delays", func(t *testing.T) {
		p := RetryPolicy{BaseDelay: 100 * time.Millisecond, MaxDelay: 5 * time.Second}
		seen := map[time.Duration]bool{}
		for i := 0; i < 32; i++ {
			d := p.backoff(2) // nominal d = 400ms -> [200ms, 400ms]
			if d < 200*time.Millisecond || d > 400*time.Millisecond {
				t.Fatalf("delay out of expected [200ms, 400ms] range: %v", d)
			}
			seen[d] = true
		}
		if len(seen) < 2 {
			t.Fatalf("expected randomized jitter across samples, got %v", seen)
		}
	})

	t.Run("deterministic bounds helper covers edges", func(t *testing.T) {
		p := RetryPolicy{BaseDelay: 100 * time.Millisecond, MaxDelay: 400 * time.Millisecond}
		if got := p.backoffWithJitter(2, func(time.Duration) time.Duration { return 0 }); got != 200*time.Millisecond {
			t.Fatalf("min jitter = %v, want 200ms", got)
		}
		if got := p.backoffWithJitter(2, func(span time.Duration) time.Duration { return span - 1 }); got != 400*time.Millisecond-1 {
			t.Fatalf("max jitter = %v, want 399.999999ms", got)
		}
	})
}
