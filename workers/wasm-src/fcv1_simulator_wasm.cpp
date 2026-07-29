#include <emscripten/emscripten.h>
#include <nlohmann/json.hpp>
#include <cstring>
#include "fcv1_simulator_core.hpp"

using json = nlohmann::json;

static std::string g_result_buffer;

extern "C"
{

    EMSCRIPTEN_KEEPALIVE
    const char *simulate_json(const char *input_json_cstr)
    {
        json input = json::parse(input_json_cstr);

        std::vector<double> position = input.at("position").get<std::vector<double>>();
        int total_shot = input.at("shot").get<int>();
        int shot_per_team = input.at("shot_per_team").get<int>();
        unsigned int team_id = input.at("team_id").get<unsigned int>();
        unsigned int applied_rule = input.at("applied_rule").get<unsigned int>();
        double x_velocity = input.at("x_velocities").get<double>();
        double y_velocity = input.at("y_velocities").get<double>();
        double angular_velocity = input.at("angular_velocities").get<double>();

        size_t stones_in_input = position.size() / 2;

        std::vector<digitalcurling3::StoneData> storage;
        storage.resize(16, digitalcurling3::StoneData(digitalcurling3::Vector2(0.0, 0.0)));

        if (stones_in_input == 16)
        {
            for (size_t i = 0; i < 16; ++i)
            {
                storage[i] = digitalcurling3::StoneData(digitalcurling3::Vector2(
                    static_cast<float>(position[2 * i]), static_cast<float>(position[2 * i + 1])));
            }
        }
        else if (stones_in_input == 12)
        {
            for (size_t i = 0; i < 6; ++i)
            {
                storage[i] = digitalcurling3::StoneData(digitalcurling3::Vector2(
                    static_cast<float>(position[2 * i]), static_cast<float>(position[2 * i + 1])));
                storage[8 + i] = digitalcurling3::StoneData(digitalcurling3::Vector2(
                    static_cast<float>(position[2 * (6 + i)]), static_cast<float>(position[2 * (6 + i) + 1])));
            }
        }
        else
        {
            g_result_buffer = R"({"error":"position must contain 12 or 16 stones"})";
            return g_result_buffer.c_str();
        }

        SimulatorFCV1 simulator(storage);
        simulator.change_shot(total_shot);
        simulator.set_stones();

        if (applied_rule == 2)
        {
            simulator.set_velocity(
                static_cast<float>(x_velocity), static_cast<float>(y_velocity),
                static_cast<float>(angular_velocity), shot_per_team + 1, team_id, applied_rule);
        }
        else
        {
            simulator.set_velocity(
                static_cast<float>(x_velocity), static_cast<float>(y_velocity),
                static_cast<float>(angular_velocity), shot_per_team, team_id, applied_rule);
        }

        std::vector<std::vector<StonePosition>> trajectory = simulator.step(0.001f);
        digitalcurling3::StoneDataVector result = simulator.get_stones();

        json output;
        json stones = json::array();
        const size_t stones_per_team_out = (stones_in_input == 12) ? 6 : 8;
        for (size_t team = 0; team < num_teams; ++team)
        {
            for (size_t stone = 0; stone < stones_per_team_out; ++stone)
            {
                const size_t internal_index = team * 8 + stone;
                stones.push_back({result.stones[internal_index].position.x, result.stones[internal_index].position.y});
            }
        }
        output["stones"] = stones;

        size_t step_count = 0;
        for (const auto &step_stones : trajectory)
        {
            if (!step_stones.empty())
            {
                step_count++;
            }
        }
        output["trajectory_steps"] = step_count;

        g_result_buffer = output.dump();
        return g_result_buffer.c_str();
    }

} // extern "C"
