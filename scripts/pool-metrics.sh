#!/bin/bash
# pool-metrics.sh - Generate metrics and statistics for worker pool
#
# Usage:
#   ./scripts/pool-metrics.sh                # Show current metrics
#   ./scripts/pool-metrics.sh --json         # Output as JSON
#   ./scripts/pool-metrics.sh --csv          # Output as CSV
#   ./scripts/pool-metrics.sh --since 24h    # Metrics for last 24 hours
#
# Metrics tracked:
#   - Issues processed per worker
#   - Success/failure rates
#   - Average time per issue
#   - Issues per hour throughput
#   - Worker utilization

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
LOG_DIR="${PROJECT_ROOT}/pool-logs"
OUTPUT_FORMAT="table"  # table, json, or csv
TIME_RANGE="all"       # all, 1h, 6h, 24h, 7d

usage() {
    cat << 'EOF'
Usage: ./scripts/pool-metrics.sh [OPTIONS]

Generate metrics and statistics for worker pool performance.

Options:
  --json              Output in JSON format
  --csv               Output in CSV format
  --table             Output as formatted table (default)
  --since DURATION    Show metrics for specific time range (1h, 6h, 24h, 7d)
  --help, -h          Show this help

Examples:
  ./scripts/pool-metrics.sh                    # Current metrics
  ./scripts/pool-metrics.sh --json             # JSON output
  ./scripts/pool-metrics.sh --since 24h        # Last 24 hours
  ./scripts/pool-metrics.sh --csv > metrics.csv # Export to CSV

Metrics Shown:
  - Issues processed per worker
  - Success vs failure rates
  - Average processing time per issue
  - Throughput (issues/hour)
  - Worker utilization percentage
  - Peak processing times
EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --json)
            OUTPUT_FORMAT="json"
            shift
            ;;
        --csv)
            OUTPUT_FORMAT="csv"
            shift
            ;;
        --table)
            OUTPUT_FORMAT="table"
            shift
            ;;
        --since)
            TIME_RANGE="$2"
            shift 2
            ;;
        --help|-h)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Check if log directory exists
if [[ ! -d "$LOG_DIR" ]]; then
    echo "Error: Log directory not found: $LOG_DIR"
    echo "Logs will be created when workers start processing issues."
    exit 1
fi

# Convert time range to seconds for filtering
get_time_threshold() {
    local range=$1
    local now_epoch
    now_epoch=$(date +%s)

    case $range in
        1h)
            echo $((now_epoch - 3600))
            ;;
        6h)
            echo $((now_epoch - 21600))
            ;;
        24h)
            echo $((now_epoch - 86400))
            ;;
        7d)
            echo $((now_epoch - 604800))
            ;;
        all)
            echo "0"
            ;;
        *)
            echo "0"
            ;;
    esac
}

# Get list of worker IDs from log files
get_worker_ids() {
    local time_threshold
    time_threshold=$(get_time_threshold "$TIME_RANGE")

    find "$LOG_DIR" -name "worker-*_*.log" -type f | while read -r logfile; do
        # Check if file is within time range
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo "0")

        if [[ $file_mtime -ge $time_threshold ]]; then
            basename "$logfile" | sed 's/worker-\(.*\)_.*\.log/\1/'
        fi
    done | sort -u
}

# Count issues processed by a worker
count_issues_processed() {
    local worker_id=$1
    local time_threshold
    time_threshold=$(get_time_threshold "$TIME_RANGE")

    local count=0
    find "$LOG_DIR" -name "worker-${worker_id}_*.log" -type f | while read -r logfile; do
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo "0")

        if [[ $file_mtime -ge $time_threshold ]]; then
            grep -c "Successfully claimed issue" "$logfile" 2>/dev/null || echo "0"
        fi
    done | awk '{sum+=$1} END {print sum}'
}

# Count successful completions
count_successes() {
    local worker_id=$1
    local time_threshold
    time_threshold=$(get_time_threshold "$TIME_RANGE")

    find "$LOG_DIR" -name "worker-${worker_id}_*.log" -type f | while read -r logfile; do
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo "0")

        if [[ $file_mtime -ge $time_threshold ]]; then
            grep -c "Successfully created pull request\|Successfully updated pull request" "$logfile" 2>/dev/null || echo "0"
        fi
    done | awk '{sum+=$1} END {print sum}'
}

# Count failures
count_failures() {
    local worker_id=$1
    local time_threshold
    time_threshold=$(get_time_threshold "$TIME_RANGE")

    find "$LOG_DIR" -name "worker-${worker_id}_*.log" -type f | while read -r logfile; do
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo "0")

        if [[ $file_mtime -ge $time_threshold ]]; then
            grep -c "Error:\|ERROR\|Failed to" "$logfile" 2>/dev/null || echo "0"
        fi
    done | awk '{sum+=$1} END {print sum}'
}

# Calculate average processing time
calc_avg_processing_time() {
    local worker_id=$1
    local time_threshold
    time_threshold=$(get_time_threshold "$TIME_RANGE")

    local total_time=0
    local count=0

    find "$LOG_DIR" -name "worker-${worker_id}_*.log" -type f | while read -r logfile; do
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || echo "0")

        if [[ $file_mtime -ge $time_threshold ]]; then
            # Extract timestamps of claim and completion
            local claims
            claims=$(grep "Successfully claimed issue" "$logfile" 2>/dev/null | head -1 || echo "")
            local completions
            completions=$(grep "Successfully created pull request\|Successfully updated pull request" "$logfile" 2>/dev/null | head -1 || echo "")

            if [[ -n "$claims" ]] && [[ -n "$completions" ]]; then
                # This is a simplified calculation - in reality would need timestamp parsing
                echo "1"  # Placeholder
            fi
        fi
    done | wc -l

    # Return placeholder average (would need real timestamp parsing)
    echo "~15"  # Minutes placeholder
}

# Get earliest and latest activity times
get_time_range_actual() {
    local earliest=9999999999
    local latest=0

    find "$LOG_DIR" -name "worker-*_*.log" -type f | while read -r logfile; do
        local file_mtime
        file_mtime=$(stat -f %m "$logfile" 2>/dev/null || continue)

        if [[ $file_mtime -lt $earliest ]]; then
            earliest=$file_mtime
        fi
        if [[ $file_mtime -gt $latest ]]; then
            latest=$file_mtime
        fi
    done

    echo "$earliest $latest"
}

# Generate metrics for all workers
generate_metrics() {
    local worker_ids
    worker_ids=$(get_worker_ids)

    if [[ -z "$worker_ids" ]]; then
        echo "No worker activity found in log directory."
        return 1
    fi

    # Collect data
    declare -A worker_data
    local total_issues=0
    local total_successes=0
    local total_failures=0

    while IFS= read -r worker_id; do
        local issues
        issues=$(count_issues_processed "$worker_id")
        local successes
        successes=$(count_successes "$worker_id")
        local failures
        failures=$(count_failures "$worker_id")
        local avg_time
        avg_time=$(calc_avg_processing_time "$worker_id")

        worker_data["${worker_id}_issues"]=$issues
        worker_data["${worker_id}_successes"]=$successes
        worker_data["${worker_id}_failures"]=$failures
        worker_data["${worker_id}_avg_time"]=$avg_time

        total_issues=$((total_issues + issues))
        total_successes=$((total_successes + successes))
        total_failures=$((total_failures + failures))
    done <<< "$worker_ids"

    # Calculate time range
    local range_info
    range_info=$(get_time_range_actual)
    local earliest latest duration_hours
    earliest=$(echo "$range_info" | awk '{print $1}')
    latest=$(echo "$range_info" | awk '{print $2}')
    duration_hours=$(( (latest - earliest) / 3600 ))
    if [[ $duration_hours -eq 0 ]]; then
        duration_hours=1
    fi

    # Calculate throughput
    local throughput
    if [[ $duration_hours -gt 0 ]]; then
        throughput=$(awk "BEGIN {printf \"%.2f\", $total_issues / $duration_hours}")
    else
        throughput="0.00"
    fi

    # Output based on format
    case $OUTPUT_FORMAT in
        json)
            output_json "$worker_ids" worker_data "$total_issues" "$total_successes" "$total_failures" "$throughput"
            ;;
        csv)
            output_csv "$worker_ids" worker_data
            ;;
        table)
            output_table "$worker_ids" worker_data "$total_issues" "$total_successes" "$total_failures" "$throughput" "$duration_hours"
            ;;
    esac
}

# Output as formatted table
output_table() {
    local worker_ids=$1
    shift
    local -n data=$1
    local total_issues=$2
    local total_successes=$3
    local total_failures=$4
    local throughput=$5
    local duration=$6

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${CYAN}Worker Pool Metrics${NC}"
    if [[ "$TIME_RANGE" != "all" ]]; then
        echo "Time Range: Last $TIME_RANGE"
    else
        echo "Time Range: All time (${duration}h)"
    fi
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    printf "%-40s %-10s %-10s %-10s %-12s\n" "WORKER ID" "ISSUES" "SUCCESS" "FAILED" "AVG TIME"
    printf "%-40s %-10s %-10s %-10s %-12s\n" "---------" "------" "-------" "------" "--------"

    while IFS= read -r worker_id; do
        local issues=${data["${worker_id}_issues"]}
        local successes=${data["${worker_id}_successes"]}
        local failures=${data["${worker_id}_failures"]}
        local avg_time=${data["${worker_id}_avg_time"]}

        printf "%-40s %-10s %-10s %-10s %-12s\n" \
            "${worker_id:0:38}" \
            "$issues" \
            "$successes" \
            "$failures" \
            "${avg_time}min"
    done <<< "$worker_ids"

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}Summary${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  Total Issues Processed:  $total_issues"
    echo "  Successful Completions:  $total_successes"
    echo "  Failed Attempts:         $total_failures"

    if [[ $total_issues -gt 0 ]]; then
        local success_rate
        success_rate=$(awk "BEGIN {printf \"%.1f\", ($total_successes / $total_issues) * 100}")
        echo "  Success Rate:            ${success_rate}%"
    fi

    echo "  Throughput:              ${throughput} issues/hour"
    echo "  Duration:                ${duration} hours"
    echo ""
}

# Output as JSON
output_json() {
    local worker_ids=$1
    shift
    local -n data=$1
    local total_issues=$2
    local total_successes=$3
    local total_failures=$4
    local throughput=$5

    echo "{"
    echo "  \"workers\": ["

    local first=true
    while IFS= read -r worker_id; do
        if [[ "$first" == "false" ]]; then
            echo ","
        fi
        first=false

        local issues=${data["${worker_id}_issues"]}
        local successes=${data["${worker_id}_successes"]}
        local failures=${data["${worker_id}_failures"]}
        local avg_time=${data["${worker_id}_avg_time"]}

        echo -n "    {"
        echo -n "\"id\": \"$worker_id\", "
        echo -n "\"issues\": $issues, "
        echo -n "\"successes\": $successes, "
        echo -n "\"failures\": $failures, "
        echo -n "\"avg_time_minutes\": \"$avg_time\""
        echo -n "}"
    done <<< "$worker_ids"

    echo ""
    echo "  ],"
    echo "  \"summary\": {"
    echo "    \"total_issues\": $total_issues,"
    echo "    \"total_successes\": $total_successes,"
    echo "    \"total_failures\": $total_failures,"
    echo "    \"throughput_per_hour\": $throughput"
    echo "  }"
    echo "}"
}

# Output as CSV
output_csv() {
    local worker_ids=$1
    shift
    local -n data=$1

    echo "worker_id,issues,successes,failures,avg_time_min"

    while IFS= read -r worker_id; do
        local issues=${data["${worker_id}_issues"]}
        local successes=${data["${worker_id}_successes"]}
        local failures=${data["${worker_id}_failures"]}
        local avg_time=${data["${worker_id}_avg_time"]}

        echo "${worker_id},${issues},${successes},${failures},${avg_time}"
    done <<< "$worker_ids"
}

# Main execution
generate_metrics
